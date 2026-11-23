import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { findSignInUrl, startAgyLoginRelay } from "../extensions/lib/relay-auth.js";
import { createAgySetup } from "../extensions/lib/setup.js";

const VERSION_OK = async () => "agy version 1.5.15";
const SIGNED_OUT = async () => {
  throw new Error("Error: authentication required. Run 'agy' to log in, then retry.");
};

/** The shapes agy is known to use for a sign-in URL. */
describe("sign-in URL extraction", () => {
  it("reads the print-mode and stderr forms", () => {
    assert.equal(
      findSignInUrl("Authentication required. Please visit the URL to log in:"),
      undefined,
      "a label without a URL relays nothing",
    );
    assert.equal(
      findSignInUrl("https://accounts.google.com/o/oauth2/auth?client_id=abc&state=1"),
      "https://accounts.google.com/o/oauth2/auth?client_id=abc&state=1",
    );
    assert.equal(
      findSignInUrl("If your browser didn't open, visit: https://antigravity.google/login?code=xyz"),
      "https://antigravity.google/login?code=xyz",
    );
  });

  it("reads the ACP field forms", () => {
    assert.equal(
      findSignInUrl(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { authUrl: "https://accounts.google.com/o/oauth2/auth?x=1" } })),
      "https://accounts.google.com/o/oauth2/auth?x=1",
    );
    assert.equal(
      findSignInUrl(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { _meta: { authorization_url: "https://accounts.google.com/o/oauth2/auth?y=2" } } })),
      "https://accounts.google.com/o/oauth2/auth?y=2",
    );
  });

  it("never mistakes the tier upsell for a sign-in link", () => {
    // Measured live against agy 1.5.15: authenticate returns the account tier
    // with an upgradeUri, and that is the only URL present when signed in.
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { _meta: { antigravity: { tier: { name: "Google AI Pro", upgradeUri: "https://antigravity.google/g1-upgrade" } } } },
    });
    assert.equal(findSignInUrl(line), undefined);
  });

  it("ignores ordinary protocol traffic and unrelated links", () => {
    assert.equal(findSignInUrl(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })), undefined);
    assert.equal(findSignInUrl("✓ Platform detected: darwin_arm64"), undefined);
    assert.equal(findSignInUrl("https://example.com/docs"), undefined);
    assert.equal(findSignInUrl("{not json"), undefined);
  });
});

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid?: number;
  killed: boolean;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  // killProcessTree reads these to decide whether the leader is already gone.
  Object.assign(child, { exitCode: null, signalCode: null, pid: undefined });
  (child as unknown as { kill: () => boolean }).kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("agy login URL relay", () => {
  it("initializes, authenticates with the Google method, and relays the URL", async () => {
    const child = fakeChild();
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8").trim()));
    const urls: string[] = [];
    const relay = startAgyLoginRelay(
      { cwd: "/p", onUrl: (url: string) => urls.push(url) },
      { spawn: () => child as never },
    );

    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        authMethods: [
          { id: "oauth-business", name: "Log in with Gemini Enterprise" },
          { id: "oauth-personal", name: "Log in with Google" },
        ],
      },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(written.map((line) => JSON.parse(line).method), ["initialize", "authenticate"]);
    assert.equal(JSON.parse(written[1]).params.methodId, "oauth-personal");

    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { auth_url: "https://accounts.google.com/o/oauth2/auth?client=a" } })}\n`);
    assert.equal(await relay.url, "https://accounts.google.com/o/oauth2/auth?client=a");
    assert.deepEqual(urls, ["https://accounts.google.com/o/oauth2/auth?client=a"]);
    // The child stays alive for the browser flow until the caller stops it.
    assert.equal(child.killed, false);
    relay.stop();
    const result = await relay.done;
    assert.equal(result.relayed, true);
    assert.equal(child.killed, true, "the child is reaped");
  });

  it("relays nothing and reports the first offered method when the CLI has no Google method", async () => {
    const child = fakeChild();
    const relay = startAgyLoginRelay({ cwd: "/p", onUrl: () => assert.fail("no URL expected") }, { spawn: () => child as never });
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [] } })}\n`);
    const result = await relay.done;
    assert.equal(result.relayed, false);
    assert.match(result.detail, /no auth methods/);
  });

  it("stops on cancellation without relaying", async () => {
    const controller = new AbortController();
    const child = fakeChild();
    const relay = startAgyLoginRelay(
      { cwd: "/p", signal: controller.signal, onUrl: () => assert.fail("no URL expected") },
      { spawn: () => child as never },
    );
    controller.abort();
    const result = await relay.done;
    assert.equal(result.relayed, false);
    assert.match(result.detail, /cancelled/);
  });
});

describe("login relays instead of only instructing", () => {
  it("hands the URL to the login UI and then completes on the probe", async () => {
    const clock = (() => {
      let time = 0;
      return { now: () => time, sleep: async (ms: number) => { time += ms; } };
    })();
    let probes = 0;
    const urls: string[] = [];
    const events: Array<{ type: string; message: string }> = [];
    const setup = createAgySetup({
      version: VERSION_OK,
      models: async () => {
        probes += 1;
        if (probes <= 2) throw new Error("Error: authentication required. Run 'agy' to log in, then retry.");
        return { "flash-medium": "gemini-3.8-flash-medium" };
      },
      now: clock.now,
      sleep: clock.sleep,
      relayLoginUrl: ({ onUrl }) => {
        onUrl("https://accounts.google.com/o/oauth2/auth?relayed=1");
        return {
          url: Promise.resolve("https://accounts.google.com/o/oauth2/auth?relayed=1"),
          done: Promise.resolve({ relayed: true, authenticated: false, detail: "relayed" }),
          stop: () => undefined,
        };
      },
    });

    const credential = await setup.login(
      {
        notify: (event) => events.push(event),
        notifyUrl: (url) => urls.push(url),
      },
      { cwd: "/p" },
    );

    assert.deepEqual(credential, { type: "api_key" });
    assert.deepEqual(urls, ["https://accounts.google.com/o/oauth2/auth?relayed=1"]);
    assert.ok(events.some((event) => /opens the browser/.test(event.message)));
  });

  it("falls back to the terminal handoff when no relay is available", async () => {
    const setup = createAgySetup({
      version: VERSION_OK,
      models: SIGNED_OUT,
      now: () => 0,
      sleep: async () => undefined,
      relayLoginUrl: () => ({
        url: Promise.resolve(undefined),
        done: Promise.resolve({ relayed: false, authenticated: false, detail: "unavailable" }),
        stop: () => undefined,
      }),
    });
    const noticed: string[] = [];
    await assert.rejects(
      setup.login(
        {
          notify: (event) => noticed.push(event.message),
          notifyUrl: () => assert.fail("nothing to relay"),
        },
        { cwd: "/p", timeoutMs: 0 },
      ),
      /not signed in/,
    );
    assert.ok(noticed.some((message) => /run `agy` in another terminal/.test(message)));
  });
});
