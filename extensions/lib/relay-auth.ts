/**
 * Relay agy's own sign-in URL into Pi's login UI.
 *
 * This is not an OAuth client. Nothing here exchanges codes, holds tokens, or
 * talks to Google: `agy acp` performs the sign-in exactly as it does in a
 * terminal, and this only drives the handshake it was built to accept
 * (`initialize` → `authenticate`) and forwards whatever URL comes back.
 *
 * Verified against agy 1.5.15: `agy acp` answers `initialize` with
 * `authMethods: [{id: "oauth-personal", name: "Log in with Google"}, …]`, and
 * the binary carries `ACP authenticate: methodId=%q` plus the print-mode lines
 * `Authentication required. Please visit the URL to log in:` /
 * `If your browser didn't open, visit:`. What could not be observed without
 * signing a real account out is the exact envelope the URL arrives in, so the
 * parser accepts every shape the binary is known to use and reports nothing
 * when it recognises none. That is why the caller always keeps the terminal
 * handoff as a fallback.
 */

import type { ChildProcess } from "node:child_process";

import { getSpawn, killProcessTree } from "./spawn.js";

/** ACP method names, as implemented by the installed CLI. */
const METHOD_INITIALIZE = "initialize";
const METHOD_AUTHENTICATE = "authenticate";
/** Preferred auth method; the CLI also offers business and API-key methods. */
const PREFERRED_AUTH_METHOD = /^oauth-personal$|google/i;

export interface RelayLoginUrlOptions {
  cwd: string;
  signal?: AbortSignal;
  /** How long to keep the child alive waiting for the browser to finish. */
  timeoutMs?: number;
  onUrl: (url: string) => void;
  /** Called when the CLI finished authenticating on its own. */
  onAuthenticated?: (detail: string) => void;
}

export interface RelayLoginUrlResult {
  /** True when a URL was relayed to the caller. */
  relayed: boolean;
  /** True when the CLI reported success by itself. */
  authenticated: boolean;
  detail: string;
}

/**
 * A bare URL is only a sign-in link if it points at one of the sign-in hosts.
 * Anything else on its own line is CLI chatter, not something to open.
 */
// Deliberately narrow: `antigravity.google/g1-upgrade` (the tier upsell in
// `_meta`) must never be mistaken for a sign-in link, so a bare host is not
// enough — the URL has to look like an OAuth endpoint.
const SIGN_IN_HOST =
  /accounts\.google\.com|oauth2\.googleapis\.com|\/(oauth|login|sign-?in|auth)(?:[/?#]|$)/i;

/**
 * Any field the observed builds use for a sign-in URL, plus a bare https
 * string that matches the sign-in hosts above.
 */
const URL_FIELDS = /^(auth_?url|authorization_?url|verification_uri|verification_url|login_?url|oauth_?url)$/i;

function collectUrls(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectUrls(entry, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      // Both the field name and the shape must say "sign-in": measured live,
      // the same payload also carries `tier.upgradeUri`, which is not a login.
      if (URL_FIELDS.test(key) && /^https:\/\//i.test(entry) && SIGN_IN_HOST.test(entry)) {
        out.push(entry);
      }
      continue;
    }
    collectUrls(entry, out);
  }
}

/**
 * Pick the first plausible sign-in URL out of one protocol line. Returns
 * undefined for anything else, including the CLI's own chatter.
 */
export function findSignInUrl(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  // Print-mode and stderr shapes: a bare URL on its own line or after a colon.
  if (/^https:\/\//i.test(trimmed)) {
    const candidate = trimmed.split(/\s+/)[0];
    return SIGN_IN_HOST.test(candidate) ? candidate : undefined;
  }
  const afterColon = /(?:visit|log in at|open):?\s+(https:\/\/\S+)/i.exec(trimmed);
  if (afterColon?.[1] && SIGN_IN_HOST.test(afterColon[1])) return afterColon[1];

  // ACP shapes: JSON-RPC envelopes carrying the URL in a known field.
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const urls: string[] = [];
      collectUrls(parsed, urls);
      if (urls.length > 0) return urls[0];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface RelayDeps {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; stdio: ("ignore" | "pipe")[]; detached: boolean },
  ): ChildProcess;
}

/**
 * A relay in flight. The caller owns its lifetime: the child stays alive while
 * the browser completes the sign-in, so it must be stopped explicitly.
 */
export interface AgyLoginRelay {
  /** Resolves with the first relayed URL, or undefined if none arrived. */
  url: Promise<string | undefined>;
  /** Resolves when the child ends, for any reason. Never rejects. */
  done: Promise<RelayLoginUrlResult>;
  /** Reap the child now. Idempotent. */
  stop(): void;
}

/**
 * Start agy's own sign-in and watch for the URL it produces. Returns
 * immediately: the child lives until `stop()`, its deadline, or cancellation,
 * because killing it would abort a browser flow it is hosting.
 */
export function startAgyLoginRelay(
  options: RelayLoginUrlOptions,
  deps: Partial<RelayDeps> = {},
): AgyLoginRelay {
  const spawn = deps.spawn ?? (getSpawn() as RelayDeps["spawn"]);
  const timeoutMs = options.timeoutMs ?? 120_000;

  let resolveDone!: (result: RelayLoginUrlResult) => void;
  let resolveUrl!: (url: string | undefined) => void;
  const done = new Promise<RelayLoginUrlResult>((resolve) => {
    resolveDone = resolve;
  });
  const url = new Promise<string | undefined>((resolve) => {
    resolveUrl = resolve;
  });

  if (options.signal?.aborted) {
    resolveUrl(undefined);
    resolveDone({ relayed: false, authenticated: false, detail: "cancelled" });
    return { url, done, stop: () => undefined };
  }

    let child: ChildProcess;
    try {
      child = spawn("agy", ["acp"], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolveUrl(undefined);
      resolveDone({
        relayed: false,
        authenticated: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { url, done, stop: () => undefined };
    }

    let settled = false;
    let relayed = false;
    let authenticated = false;
    let buffer = "";
    let stderrBuffer = "";
    let authMethodId: string | undefined;

    const finish = (detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        child.stdin?.end();
      } catch {
        // The child may already be gone.
      }
      killProcessTree(child);
      resolveUrl(undefined);
      resolveDone({ relayed, authenticated, detail });
    };

    const send = (payload: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // A dead stdin settles through close/error below.
      }
    };

    const handleLine = (line: string): void => {
      if (settled) return;
      const url = findSignInUrl(line);
      if (url && !relayed) {
        relayed = true;
        resolveUrl(url);
        try {
          options.onUrl(url);
        } catch {
          // A failing UI surface must not abort the sign-in the CLI is hosting.
        }
      }

      if (!line.trim().startsWith("{")) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const result = message.result as Record<string, unknown> | undefined;
      if (message.id === 1 && result) {
        // initialize answered: authenticate with the Google method it offers.
        const methods = Array.isArray(result.authMethods)
          ? (result.authMethods as Array<{ id?: unknown }>)
          : [];
        const ids = methods.map((method) => String(method.id ?? "")).filter(Boolean);
        authMethodId = ids.find((id) => PREFERRED_AUTH_METHOD.test(id)) ?? ids[0];
        if (!authMethodId) {
          finish("agy acp offered no auth methods");
          return;
        }
        send({
          jsonrpc: "2.0",
          id: 2,
          method: METHOD_AUTHENTICATE,
          params: { methodId: authMethodId },
        });
        return;
      }
      if (message.id === 2) {
        const failed = message.error !== undefined;
        if (failed) {
          finish(`authenticate failed: ${JSON.stringify(message.error).slice(0, 200)}`);
          return;
        }
        // A successful authenticate may mean the account was already usable,
        // or that the browser flow finished. Report it and let the caller
        // confirm with its own probe.
        authenticated = true;
        finish("agy authenticated");
      }
    };

    const pump = (chunk: Buffer, into: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (into === "err") stderrBuffer = (stderrBuffer + text).slice(-4_000);
      buffer += text;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        if (settled) return;
      }
    };

    const timer = setTimeout(() => finish("timed out waiting for agy"), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const onAbort = () => finish("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer) => pump(data, "out"));
    child.stderr?.on("data", (data: Buffer) => pump(data, "err"));
    child.on("error", (error: Error) => finish(error.message));
    child.on("close", (code: number | null) => {
      if (settled) return;
      const tail = stderrBuffer.trim().split("\n").slice(-1)[0] ?? "";
      finish(tail || `agy acp exited ${code ?? "on a signal"}`);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: METHOD_INITIALIZE,
      params: { protocolVersion: 1, clientCapabilities: {} },
    });

    return { url, done, stop: () => finish("stopped by caller") };
  }
