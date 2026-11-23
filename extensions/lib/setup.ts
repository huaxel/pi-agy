/**
 * Guided Antigravity setup: the handoff, not the sign-in.
 *
 * pi-agy never performs OAuth and never stores credentials. That is deliberate:
 * agy owns the account, the tokens, and the network call, and the whole reason
 * this package is not a "shim" is that it stops at driving Google's own binary.
 *
 * What can still be taken off the user's hands is the seam. Before this, a
 * signed-out machine looked like an empty `/model` picker and a turn that named
 * the fix only after it failed. Here the state is detected up front
 * (`missing-cli`, `signed-out`, `ready`), the one command that fixes it is
 * named exactly, and a poll can watch for the sign-in to land in another
 * terminal so the picker fills in without a restart.
 *
 * This module is also the `/login antigravity` flow. Pi models auth as
 * credentials *it* owns; for Antigravity the credential is just a marker that
 * `agy` is signed in, which is why `login()` returns an empty api-key record
 * and why `resolve()` never gates on the network.
 */

import * as os from "node:os";
import * as path from "node:path";
import { access, constants } from "node:fs/promises";

import { inspectAgyModels, inspectAgyVersion } from "./inspect.js";
import { startAgyLoginRelay, type AgyLoginRelay } from "./relay-auth.js";
import { isAgyAuthFailure } from "./auth.js";
import { appendBounded, getSpawn, INSTALL_HINT, killProcessTree, MAX_CAPTURE_BYTES } from "./spawn.js";

export type AgySetupState = "ready" | "signed-out" | "missing-cli" | "error";

export interface AgySetupStatus {
  state: AgySetupState;
  /** One sentence for the user: what is wrong and what fixes it. */
  detail: string;
  /** Discovered model count when `ready`. */
  models?: number;
}

export interface AgySetupDetectOptions {
  cwd: string;
  signal?: AbortSignal;
}

export interface AgySetupWaitOptions extends AgySetupDetectOptions {
  /** Total wait for the sign-in to appear in agy. */
  timeoutMs?: number;
  onProgress?: (elapsedMs: number) => void;
}

/** How long a guided wait watches for the user to finish `agy`'s sign-in. */
export const SETUP_WAIT_TIMEOUT_MS = 5 * 60_000;
/** Gap between probes. `agy models` is a network call, so this stays coarse. */
export const SETUP_POLL_INTERVAL_MS = 3_000;

/** The minimum a login interaction must offer; matches pi-ai's AuthInteraction. */
export interface AgyLoginInteraction {
  signal?: AbortSignal;
  notify(event: { type: "info"; message: string } | { type: "progress"; message: string }): void;
  /**
   * Pi's login surface can render a sign-in URL as an openable link (its
   * `auth_url` event). Without it the terminal handoff is used instead.
   */
  notifyUrl?(url: string): void;
  /** Optional: Pi's login surface offers select prompts; tests can omit it. */
  prompt?(prompt: {
    type: "select";
    message: string;
    options: { id: string; label: string }[];
  }): Promise<string>;
}

/** The credential Pi stores. It carries no secret because agy holds the account. */
export interface AgyLoginCredential {
  type: "api_key";
}

interface AgySetupProbes extends AgyInstallProbes {
  version(cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<string>;
  models(cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, string>>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** Make a freshly installed binary findable without restarting Pi. */
  adopt(): Promise<boolean>;
  /**
   * Start agy's own sign-in and hand back the URL it produces. Optional: when
   * it cannot be started or yields nothing, the caller falls back to the
   * terminal handoff.
   */
  relayLoginUrl?(options: {
    cwd: string;
    signal?: AbortSignal;
    onUrl: (url: string) => void;
  }): AgyLoginRelay;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("agy setup was cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("agy setup was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const NOT_INSTALLED = /not installed/i;

/** Google's official installers. Only these are ever executed — never user input. */
export const AGY_INSTALL_SCRIPT_URL = "https://antigravity.google/cli/install.sh";
export const AGY_INSTALL_SCRIPT_URL_WIN = "https://antigravity.google/cli/install.ps1";
/** Where the Unix installer writes the binary; no sudo, no system directories. */
export const AGY_INSTALL_DIR = path.join(os.homedir(), ".local", "bin");
export const AGY_INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface AgyInstallCommand {
  command: string;
  args: string[];
  /** Exactly what the user is consenting to, and what a failure message quotes. */
  display: string;
}

/**
 * The official installer, quoted exactly. On Unix it is Google's bootstrapper,
 * which downloads the release for this platform, verifies the manifest's
 * SHA-512, and writes `~/.local/bin/agy` before configuring shell paths.
 */
export function agyInstallCommand(platform: NodeJS.Platform = process.platform): AgyInstallCommand {
  if (platform === "win32") {
    const display = `irm ${AGY_INSTALL_SCRIPT_URL_WIN} | iex`;
    return { command: "powershell", args: ["-NoProfile", "-Command", display], display };
  }
  const display = `curl -fsSL ${AGY_INSTALL_SCRIPT_URL} | bash`;
  return { command: "sh", args: ["-c", display], display };
}

export interface AgyInstallOutcome {
  ok: boolean;
  /** One line for the user: what happened, or the tail of the failure. */
  detail: string;
  output: string;
}

interface AgyInstallProbes {
  run(
    install: AgyInstallCommand,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<AgyInstallOutcome>;
}

/**
 * Run the official installer, bounded. Output is captured (never inherited) so
 * a chatty installer cannot scribble over Pi's TUI.
 */
function runInstaller(
  install: AgyInstallCommand,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<AgyInstallOutcome> {
  return new Promise<AgyInstallOutcome>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, detail: "installer cancelled", output: "" });
      return;
    }
    let child;
    try {
      child = getSpawn()(install.command, install.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error), output: "" });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (data: Buffer): void => {
      bytes = appendBounded(chunks, bytes, data);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(1_000, options.timeoutMs));
    (timer as unknown as { unref?: () => void }).unref?.();
    const onAbort = () => killProcessTree(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const output = Buffer.concat(chunks).toString("utf8").trim().slice(-MAX_CAPTURE_BYTES);
      resolve({ ok, detail, output });
    };

    child.on("error", (error: Error) => finish(false, `installer could not start: ${error.message}`));
    child.on("close", (code: number | null) => {
      if (options.signal?.aborted) finish(false, "installer cancelled");
      else if (timedOut) finish(false, `installer timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      else if (code === 0) finish(true, "installer finished");
      else finish(false, `installer exited ${code ?? "on a signal"}`);
    });
  });
}

/**
 * The installer writes to `~/.local/bin`, which is frequently absent from the
 * PATH a running process inherited. Adopt it so the freshly installed CLI is
 * usable without restarting Pi.
 */
export async function adoptInstalledAgy(installDir = AGY_INSTALL_DIR): Promise<boolean> {
  const binary = path.join(installDir, process.platform === "win32" ? "agy.exe" : "agy");
  try {
    await access(binary, constants.X_OK);
  } catch {
    return false;
  }
  const current = process.env.PATH ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(installDir)) return true;
  process.env.PATH = [installDir, ...parts].join(path.delimiter);
  return true;
}

/**
 * Build a setup helper. Probes are injectable so the state machine is testable
 * without spawning agy (and so a caller can bound its own timeouts).
 */
/** One sentence plus the installer's own last words, never a stack. */
export function installFailureDetail(outcome: AgyInstallOutcome): string {
  const tail = outcome.output.split("\n").filter((line) => line.trim()).slice(-3).join(" / ");
  return `${outcome.detail}${tail ? ` — ${tail}` : ""}. You can also run it yourself: ${agyInstallCommand().display}`;
}

export function createAgySetup(overrides: Partial<AgySetupProbes> = {}) {
  const probes: AgySetupProbes = {
    version: inspectAgyVersion,
    models: inspectAgyModels,
    sleep: defaultSleep,
    now: () => Date.now(),
    run: runInstaller,
    adopt: () => adoptInstalledAgy(),
    // Relay agy's own sign-in URL; nothing here performs OAuth.
    relayLoginUrl: (options) => startAgyLoginRelay({ ...options, timeoutMs: 120_000 }),
    ...overrides,
  };

  /** Name the state once, so every surface says the same thing. */
  async function detect(options: AgySetupDetectOptions): Promise<AgySetupStatus> {
    const { cwd, signal } = options;
    try {
      await probes.version(cwd, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (NOT_INSTALLED.test(message)) {
        return { state: "missing-cli", detail: `${message.split(".")[0]}. ${INSTALL_HINT}` };
      }
      if (isAgyAuthFailure(message)) {
        return { state: "signed-out", detail: signedOutDetail(message) };
      }
      return { state: "error", detail: message };
    }

    try {
      const catalog = await probes.models(cwd, signal);
      const models = Object.keys(catalog).length;
      return {
        state: "ready",
        detail: models > 0 ? `agy is installed and signed in (${models} models)` : "agy is installed but reported no models",
        models,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // A signed-out CLI fails the models probe, sometimes by waiting for a
      // browser sign-in that cannot happen here. Name the state, not the noise.
      if (isAgyAuthFailure(message)) return { state: "signed-out", detail: signedOutDetail(message) };
      return { state: "error", detail: message };
    }
  }

  function signedOutDetail(agySaid: string): string {
    return `agy is not signed in. Run \`agy\` in a terminal and finish the browser sign-in, then retry. (agy said: ${agySaid.trim().slice(0, 200)})`;
  }

  /**
   * Poll until `agy` reports a usable account, the deadline passes, or the
   * caller cancels. Returns the last observed status; never throws on a
   * transient signed-out state.
   */
  async function waitForSignIn(options: AgySetupWaitOptions): Promise<AgySetupStatus> {
    const start = probes.now();
    const timeoutMs = options.timeoutMs ?? SETUP_WAIT_TIMEOUT_MS;
    let status = await detect(options);
    while (status.state !== "ready" && probes.now() - start < timeoutMs) {
      if (options.signal?.aborted) throw new Error("agy setup was cancelled");
      options.onProgress?.(probes.now() - start);
      await probes.sleep(SETUP_POLL_INTERVAL_MS, options.signal);
      // Cancellation must not depend on a probe noticing the signal itself.
      if (options.signal?.aborted) throw new Error("agy setup was cancelled");
      status = await detect(options);
    }
    return status;
  }

  /**
   * Start agy's own sign-in (it opens the browser itself) and hand back a
   * handle. Undefined when no relay is available; callers then rely on the
   * wait alone.
   */
  function startSignIn(options: {
    cwd: string;
    signal?: AbortSignal;
    onUrl?: (url: string) => void;
  }): AgyLoginRelay | undefined {
    if (!probes.relayLoginUrl) return undefined;
    return probes.relayLoginUrl({
      cwd: options.cwd,
      signal: options.signal,
      onUrl: (url) => options.onUrl?.(url),
    });
  }

  /**
   * Run Google's official installer. Consent is the caller's job: this never
   * asks, and it only ever executes the pinned official command.
   */
  async function install(options: AgySetupDetectOptions & { timeoutMs?: number } = { cwd: process.cwd() }): Promise<AgyInstallOutcome> {
    const outcome = await probes.run(agyInstallCommand(), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? AGY_INSTALL_TIMEOUT_MS,
    });
    if (!outcome.ok) return outcome;
    // The binary usually lands in ~/.local/bin, which this process may not have
    // on PATH yet; adopt it, then report whether it is actually usable.
    await probes.adopt();
    const status = await detect(options);
    return {
      ok: status.state !== "missing-cli",
      detail: status.detail,
      output: outcome.output,
    };
  }

  /**
   * The `/login antigravity` flow. agy owns the sign-in, so this only checks,
   * waits, and hands the user the exact command — never a credential.
   */
  async function login(
    interaction: AgyLoginInteraction,
    options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
  ): Promise<AgyLoginCredential> {
    const signal = interaction.signal;
    const initial = await detect({ cwd: options.cwd, signal });
    if (initial.state === "ready") {
      interaction.notify({
        type: "info",
        message: `${initial.detail}. Nothing to do — Pi stores only a marker; your Google credentials stay with agy.`,
      });
      return { type: "api_key" };
    }
    if (initial.state === "missing-cli") {
      const choice = await interaction.prompt?.({
        type: "select",
        message: "agy is not installed. Install Google's CLI now?",
        options: [
          { id: "install", label: `Run Google's official installer (${agyInstallCommand().display})` },
          { id: "show", label: "No — just show me the command" },
        ],
      });
      if (choice !== "install") throw new Error(initial.detail);
      interaction.notify({ type: "info", message: `running the official installer: ${agyInstallCommand().display}` });
      const outcome = await install({ cwd: options.cwd, signal });
      if (!outcome.ok) throw new Error(installFailureDetail(outcome));
      if (outcome.detail === initial.detail) throw new Error(installFailureDetail(outcome));
      const afterInstall = await detect({ cwd: options.cwd, signal });
      if (afterInstall.state === "ready") {
        interaction.notify({ type: "info", message: `${afterInstall.detail}. Nothing else to do.` });
        return { type: "api_key" };
      }
      // Installed but signed out: fall through to the wait below.
      interaction.notify({ type: "info", message: afterInstall.detail });
    } else if (initial.state === "error") {
      throw new Error(initial.detail);
    }
    // Start agy's own sign-in and relay the URL it produces into Pi's login
    // UI. agy still performs the exchange and opens the browser; the relay
    // exists for when no browser opens, and the terminal handoff stays as the
    // fallback when the relay yields nothing.
    const relay = interaction.notifyUrl && probes.relayLoginUrl
      ? probes.relayLoginUrl({
          cwd: options.cwd,
          signal,
          onUrl: (url) => interaction.notifyUrl?.(url),
        })
      : undefined;

    interaction.notify({
      type: "info",
      message:
        "agy owns the sign-in: it opens the browser and completes the exchange itself. If no browser opens, run `agy` in another terminal — this picks the sign-in up automatically.",
    });
    const final = await waitForSignIn({
      cwd: options.cwd,
      signal,
      timeoutMs: options.timeoutMs,
      onProgress: (elapsedMs) =>
        interaction.notify({
          type: "progress",
          message: `waiting for agy sign-in (${Math.round(elapsedMs / 1000)}s)…`,
        }),
    });
    if (final.state !== "ready") throw new Error(final.detail);
    relay?.stop();
    interaction.notify({
      type: "info",
      message: `${final.detail}. Pi stores only a marker; your Google credentials stay with agy.`,
    });
    return { type: "api_key" };
  }

  return { detect, waitForSignIn, startSignIn, login };
}

export type AgySetup = ReturnType<typeof createAgySetup>;
