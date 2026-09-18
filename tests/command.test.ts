import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execFile);

import {
  buildAgyArgs,
  buildAgyPrompt,
  isAgyModel,
  isTransientAgyFailure,
  parseModelCatalog,
  resetModelCatalog,
  resolveAgyModelId,
  updateModelCatalog,
} from "../extensions/lib/cli.js";
import { resolveAgyMode, truncate } from "../extensions/index.js";
import piAgyExtension from "../extensions/index.js";
import { registerAgyCommand } from "../extensions/commands.js";
import { executeAgyTask } from "../extensions/lib/execute.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";
import { withDirLock } from "../extensions/lib/lock.js";
import { detectVerifyCommand } from "../extensions/lib/verify.js";
import { summarizeGitDiff } from "../extensions/lib/postflight.js";
import { loadAgyConfig, resetDefaultModelCache, resolveDefaultModel } from "../extensions/lib/config.js";
import {
  accumulateRunResult,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
} from "../extensions/lib/stream.js";
import { parseJsonResponse } from "../extensions/lib/parse.js";
import { parseAgyCommandArgs } from "../extensions/commands.js";
import { createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
import { hasFlagPair, readFakeAgyArgs, withFakeAgy } from "./helpers.js";
describe("/agy command", () => {
  it("completes modes, models, continue, and sessions from a bare prefix", () => {
    let getCompletions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
    const fakePi = {
      registerCommand: (
        _name: string,
        definition: {
          getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
        },
      ) => {
        getCompletions = definition.getArgumentCompletions;
      },
    };
    registerAgyCommand(fakePi as unknown as ExtensionAPI);
    assert.ok(getCompletions);

    const bare = getCompletions!("")!.map((c) => c.value);
    for (const expected of ["plan", "flash", "sonnet", "continue", "sessions"]) {
      assert.ok(bare.includes(expected), `missing completion: ${expected}`);
    }

    const afterMode = getCompletions!("plan ")!.map((c) => c.value);
    assert.ok(afterMode.includes("flash-medium"));
    assert.ok(afterMode.includes("continue"));
    assert.ok(!afterMode.includes("plan"));

    const afterUsage = getCompletions!("usage f")!.map((c) => c.value);
    assert.ok(afterUsage.includes("flash-medium"));
    assert.ok(!afterUsage.includes("sonnet"));

    assert.equal(getCompletions!("plan flash review the diff"), null);
  });

  it("executes directly without sending a second user message", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "direct result", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      let waitForIdleCalls = 0;
      const statuses: Array<[string, string | undefined]> = [];
      const notifications: Array<[string, string | undefined]> = [];
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      const fakePi = {
        registerCommand: (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      };
      registerAgyCommand(fakePi as unknown as ExtensionAPI);

      await handler!("plan flash inspect files", {
        mode: "tui",
        cwd: process.cwd(),
        signal: undefined,
        waitForIdle: async () => {
          waitForIdleCalls++;
        },
        ui: {
          setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
          notify: (message: string, type?: "info" | "warning" | "error") =>
            notifications.push([message, type]),
        },
      } as unknown as ExtensionCommandContext);

      assert.equal(waitForIdleCalls, 1);
      assert.ok(statuses.some(([, text]) => text?.includes("starting")));
      assert.deepEqual(statuses.at(-1), ["agy", undefined]);
      assert.ok(notifications.some(([message]) => message.includes("direct result")));
    });
  });

  it("resumes a recorded conversation via /agy sessions", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const cwd = process.cwd();
    await writeFile(
      path.join(agentDir, "agy-sessions.json"),
      JSON.stringify({
        [cwd]: {
          history: [
            {
              conversation_id: "conv-1111",
              model: "flash-medium",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      }),
    );

    const raw =
      JSON.stringify({ event: "result", result: { response: "resumed", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(raw, async (bin) => {
      resetPreflightCache();
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        let handler:
          | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        const fakePi = {
          registerCommand: (
            _name: string,
            definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
          ) => {
            handler = definition.handler;
          },
        };
        registerAgyCommand(fakePi as unknown as ExtensionAPI);

        const selections: string[] = [];
        const notifications: Array<[string, string | undefined]> = [];
        await handler!("sessions", {
          mode: "tui",
          cwd,
          signal: undefined,
          waitForIdle: async () => {},
          ui: {
            select: async (_title: string, options: string[]) => {
              const pick = options[0];
              selections.push(pick);
              return pick;
            },
            editor: async () => "continue the refactor",
            confirm: async () => true,
            setStatus: () => {},
            notify: (message: string, type?: "info" | "warning" | "error") =>
              notifications.push([message, type]),
          },
        } as unknown as ExtensionCommandContext);

        assert.deepEqual(selections, [
          "1. flash-medium · just now · conv-111…",
          "accept-edits — writes files (default)",
        ]);
        const args = await readFakeAgyArgs(bin);
        assert.ok(args.some((argv) => hasFlagPair(argv, "--conversation", "conv-1111")));
        assert.ok(notifications.some(([message]) => message.includes("resumed")));
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    });
  });
});


describe("parseAgyCommandArgs", () => {
  it("parses model alias + prompt (no mode)", () => {
    const parsed = parseAgyCommandArgs("flash fix git conflicts");
    assert.equal(parsed.model, "flash-medium");
    assert.equal(parsed.mode, undefined);
    assert.equal(parsed.prompt, "fix git conflicts");
  });

  it("parses plan mode + model", () => {
    const parsed = parseAgyCommandArgs("plan sonnet review the diff");
    assert.equal(parsed.model, "sonnet");
    assert.equal(parsed.mode, "plan");
    assert.equal(parsed.prompt, "review the diff");
  });

  it("leaves model/mode unset when only prompt given", () => {
    const parsed = parseAgyCommandArgs("just do the thing");
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.mode, undefined);
    assert.equal(parsed.prompt, "just do the thing");
  });

  it("parses sandbox + full alias", () => {
    const parsed = parseAgyCommandArgs("sandbox pro-high estimate the refactor");
    assert.equal(parsed.model, "pro-high");
    assert.equal(parsed.mode, "sandbox");
    assert.equal(parsed.prompt, "estimate the refactor");
  });

  it("parses explicit accept-edits mode case-insensitively", () => {
    const parsed = parseAgyCommandArgs("ACCEPT-EDITS flash implement the fix");
    assert.equal(parsed.model, "flash-medium");
    assert.equal(parsed.mode, "accept-edits");
    assert.equal(parsed.prompt, "implement the fix");
  });

  it("preserves multiline prompt formatting", () => {
    const parsed = parseAgyCommandArgs("plan flash review these files:\n- one\n- two");
    assert.equal(parsed.prompt, "review these files:\n- one\n- two");
  });

  it("returns empty object for bare /agy", () => {
    const parsed = parseAgyCommandArgs("");
    assert.deepEqual(parsed, {});
  });

  it("parses continue and timeout tokens", () => {
    const parsed = parseAgyCommandArgs("continue timeout=10m fix the failing tests");
    assert.equal(parsed.continue, true);
    assert.equal(parsed.timeout_ms, 600_000);
    assert.equal(parsed.prompt, "fix the failing tests");
  });

  it("parses timeout in seconds, milliseconds, and bare minutes", () => {
    assert.equal(parseAgyCommandArgs("timeout=90s do it").timeout_ms, 90_000);
    assert.equal(parseAgyCommandArgs("timeout=8 do it").timeout_ms, 480_000);
    assert.equal(parseAgyCommandArgs("timeout=1500ms do it").timeout_ms, 1_500);
  });

  it("does not swallow continue inside the prompt body", () => {
    const parsed = parseAgyCommandArgs("plan review, then continue");
    assert.equal(parsed.continue, undefined);
    assert.equal(parsed.prompt, "review, then continue");
  });
});


