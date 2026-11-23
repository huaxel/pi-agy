import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgySetup, SETUP_POLL_INTERVAL_MS, type AgyLoginInteraction } from "../extensions/lib/setup.js";
import { INSTALL_HINT } from "../extensions/lib/spawn.js";

const VERSION_OK = async () => "agy version 1.5.15";
const MODELS_OK = async () => ({ "flash-medium": "gemini-3.8-flash-medium", "sonnet": "claude-sonnet-4-6" });
const NOT_INSTALLED_ERROR = async () => {
  throw new Error(`Antigravity CLI is not installed. ${INSTALL_HINT}`);
};
const SIGNED_OUT_ERROR = async () => {
  throw new Error("agy connectivity check failed (exit 1). Error: authentication required. Run 'agy' to log in, then retry.");
};

/** A clock the test advances instead of waiting. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

function interaction() {
  const events: Array<{ type: string; message: string }> = [];
  const value: AgyLoginInteraction & { events: typeof events } = {
    events,
    notify: (event) => {
      events.push(event);
    },
  };
  return value;
}

describe("agy setup detection", () => {
  it("reports a missing CLI with the official install command", async () => {
    const setup = createAgySetup({ version: NOT_INSTALLED_ERROR });
    const status = await setup.detect({ cwd: "/p" });
    assert.equal(status.state, "missing-cli");
    assert.match(status.detail, /not installed/);
    assert.ok(status.detail.includes(INSTALL_HINT));
  });

  it("reports a signed-out CLI instead of a generic probe failure", async () => {
    const setup = createAgySetup({ version: VERSION_OK, models: SIGNED_OUT_ERROR });
    const status = await setup.detect({ cwd: "/p" });
    assert.equal(status.state, "signed-out");
    assert.match(status.detail, /not signed in/);
    assert.match(status.detail, /run `agy` in a terminal/i);
  });

  it("reads the verbatim signed-out answer from `agy models`", async () => {
    // Captured live from agy 1.5.15 after a real sign-out. It shares no words
    // with the print-mode wording, which is how this state was once reported
    // as a broken CLI instead of a signed-out one.
    const setup = createAgySetup({
      version: VERSION_OK,
      models: async () => {
        throw new Error(
          "agy connectivity check failed (exit 1). Fetching available models...\n" +
            "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
        );
      },
    });
    const status = await setup.detect({ cwd: "/p" });
    assert.equal(status.state, "signed-out");
  });

  it("reports ready with the discovered model count", async () => {
    const setup = createAgySetup({ version: VERSION_OK, models: MODELS_OK });
    const status = await setup.detect({ cwd: "/p" });
    assert.equal(status.state, "ready");
    assert.equal(status.models, 2);
  });

  it("keeps an unrelated failure distinct from the two actionable states", async () => {
    const setup = createAgySetup({
      version: VERSION_OK,
      models: async () => {
        throw new Error("agy connectivity check timed out");
      },
    });
    const status = await setup.detect({ cwd: "/p" });
    assert.equal(status.state, "error");
    assert.match(status.detail, /timed out/);
  });

  it("does not hide a cancelled probe as an error state", async () => {
    const controller = new AbortController();
    const setup = createAgySetup({
      version: async () => {
        controller.abort();
        throw new Error("agy health check was cancelled");
      },
    });
    await assert.rejects(setup.detect({ cwd: "/p", signal: controller.signal }), /cancelled/);
  });
});

describe("agy setup wait", () => {
  it("polls until the sign-in lands and reports progress", async () => {
    const clock = fakeClock();
    let probes = 0;
    const setup = createAgySetup({
      version: VERSION_OK,
      // Signed out twice, then signed in: the shape of a user finishing the
      // browser flow while Pi waits.
      models: async () => {
        probes += 1;
        if (probes < 3) throw new Error("Error: authentication required. Run 'agy' to log in, then retry.");
        return { "flash-medium": "gemini-3.8-flash-medium" };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const progress: number[] = [];
    const status = await setup.waitForSignIn({ cwd: "/p", onProgress: (ms) => progress.push(ms) });
    assert.equal(status.state, "ready");
    assert.equal(status.models, 1);
    assert.equal(probes, 3);
    assert.deepEqual(clock.sleeps, [SETUP_POLL_INTERVAL_MS, SETUP_POLL_INTERVAL_MS]);
    assert.equal(progress.length, 2);
  });

  it("gives up at the deadline with the last observed state", async () => {
    const clock = fakeClock();
    const setup = createAgySetup({
      version: VERSION_OK,
      models: SIGNED_OUT_ERROR,
      now: clock.now,
      sleep: clock.sleep,
    });
    const status = await setup.waitForSignIn({ cwd: "/p", timeoutMs: SETUP_POLL_INTERVAL_MS * 2 });
    assert.equal(status.state, "signed-out");
    assert.equal(clock.sleeps.length, 2);
  });

  it("stops immediately when the caller cancels", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const setup = createAgySetup({
      version: VERSION_OK,
      models: SIGNED_OUT_ERROR,
      now: clock.now,
      sleep: async (ms) => {
        clock.sleep(ms);
        controller.abort();
        await clock.sleep(ms);
      },
    });
    await assert.rejects(
      setup.waitForSignIn({ cwd: "/p", signal: controller.signal }),
      /cancelled/,
    );
  });
});

describe("agy login flow", () => {
  it("is a no-op when agy is already signed in", async () => {
    const setup = createAgySetup({ version: VERSION_OK, models: MODELS_OK });
    const ui = interaction();
    assert.deepEqual(await setup.login(ui, { cwd: "/p" }), { type: "api_key" });
    assert.equal(ui.events.length, 1);
    assert.match(ui.events[0].message, /Nothing to do/);
    assert.match(ui.events[0].message, /credentials stay with agy/);
  });

  it("fails with the install command instead of pretending to log in", async () => {
    const setup = createAgySetup({ version: NOT_INSTALLED_ERROR });
    const ui = interaction();
    await assert.rejects(setup.login(ui, { cwd: "/p" }), (error: Error) => {
      assert.ok(error.message.includes(INSTALL_HINT));
      return true;
    });
    assert.equal(ui.events.length, 0);
  });

  it("starts agy's sign-in instead of only waiting for it", async () => {
    const calls: string[] = [];
    const setup = createAgySetup({
      version: VERSION_OK,
      models: SIGNED_OUT_ERROR,
      relayLoginUrl: () => {
        calls.push("started");
        return {
          url: Promise.resolve(undefined),
          done: Promise.resolve({ relayed: false, authenticated: false, detail: "stopped" }),
          stop: () => calls.push("stopped"),
        };
      },
    });
    const relay = setup.startSignIn({ cwd: "/p", onUrl: () => undefined });
    assert.ok(relay);
    assert.deepEqual(calls, ["started"]);
    relay.stop();
    assert.deepEqual(calls, ["started", "stopped"]);
  });

  it("has no sign-in to start when relays are unavailable", () => {
    const setup = createAgySetup({ version: VERSION_OK, models: SIGNED_OUT_ERROR, relayLoginUrl: undefined });
    assert.equal(setup.startSignIn({ cwd: "/p" }), undefined);
  });

  it("waits for the user to sign in with agy and then succeeds", async () => {
    const clock = fakeClock();
    let probes = 0;
    const setup = createAgySetup({
      version: VERSION_OK,
      models: async () => {
        probes += 1;
        // Probe 1 is login's own check, probe 2 the first poll: still signed out.
        if (probes <= 2) throw new Error("Error: authentication required. Run 'agy' to log in, then retry.");
        return MODELS_OK();
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const ui = interaction();
    assert.deepEqual(await setup.login(ui, { cwd: "/p" }), { type: "api_key" });
    assert.equal(ui.events[0].type, "info");
    assert.match(ui.events[0].message, /run `agy` in another terminal/);
    assert.ok(ui.events.some((event) => event.type === "progress"));
    assert.match(ui.events.at(-1)!.message, /credentials stay with agy/);
  });

  it("rejects with the recovery text when the sign-in never arrives", async () => {
    const clock = fakeClock();
    const setup = createAgySetup({
      version: VERSION_OK,
      models: SIGNED_OUT_ERROR,
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(setup.login(interaction(), { cwd: "/p", timeoutMs: SETUP_POLL_INTERVAL_MS }), /not signed in/);
  });
});
