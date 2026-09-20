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
    for (const expected of [
      "plan",
      "flash",
      "sonnet",
      "continue",
      "sessions",
      "agents",
      "agent=",
      "doctor",
      "context=summary",
      "timeout=10m",
    ]) {
      assert.ok(bare.includes(expected), `missing completion: ${expected}`);
    }

    const afterMode = getCompletions!("plan ")!.map((c) => c.value);
    assert.ok(afterMode.includes("flash-medium"));
    assert.ok(afterMode.includes("agent="));
    assert.ok(afterMode.includes("continue"));
    assert.ok(afterMode.includes("timeout=10m"));
    assert.ok(!afterMode.includes("plan"));

    const afterUsage = getCompletions!("usage f")!.map((c) => c.value);
    assert.ok(afterUsage.includes("flash-medium"));
    assert.ok(!afterUsage.includes("sonnet"));
    assert.ok(!afterUsage.includes("timeout=10m"));

    assert.equal(getCompletions!("plan flash review the diff"), null);
  });

  it("rejects doctor arguments without falling through to the task wizard", async () => {
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

    const notifications: Array<[string, string | undefined]> = [];
    await handler!("doctor --json", {
      mode: "tui",
      cwd: process.cwd(),
      waitForIdle: async () => {},
      ui: {
        select: async () => {
          throw new Error("doctor arguments fell through to the task wizard");
        },
        notify: (message: string, type?: "info" | "warning" | "error") =>
          notifications.push([message, type]),
      },
    } as unknown as ExtensionCommandContext);

    assert.deepEqual(notifications, [["agy: doctor takes no arguments", "error"]]);
  });

  it("runs doctor diagnostics and delivers the report through the UI", async () => {
    await withFakeAgy("", async () => {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-command-"));
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
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

        const statuses: Array<[string, string | undefined]> = [];
        const notifications: Array<[string, string | undefined]> = [];
        await handler!("doctor", {
          mode: "tui",
          cwd: process.cwd(),
          waitForIdle: async () => {},
          ui: {
            setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
            notify: (message: string, type?: "info" | "warning" | "error") =>
              notifications.push([message, type]),
          },
        } as unknown as ExtensionCommandContext);

        assert.ok(statuses.some(([, text]) => text === "agy: running diagnostics…"));
        assert.deepEqual(statuses.at(-1), ["agy", undefined]);
        assert.ok(notifications.some(([message]) => message.startsWith("agy doctor — ")));
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    });
  });

  it("lists configured custom agents without starting an inference turn", async () => {
    await withFakeAgy("", async (bin) => {
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      registerAgyCommand({
        registerCommand: (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      } as unknown as ExtensionAPI);
      const notifications: Array<[string, string | undefined]> = [];
      await handler!("agents", {
        mode: "tui",
        cwd: process.cwd(),
        waitForIdle: async () => {},
        ui: {
          setStatus: () => {},
          notify: (message: string, type?: "info" | "warning" | "error") =>
            notifications.push([message, type]),
        },
      } as unknown as ExtensionCommandContext);
      assert.deepEqual(notifications, [["configured agy agents:\n- fake-agent", "info"]]);
      assert.deepEqual(await readFakeAgyArgs(bin), [["agents"]]);
    });
  });

  it("executes directly without sending a second user message", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "direct result", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(raw, async (bin) => {
      resetPreflightCache();
      const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-command-work-"));
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-command-agent-"));
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      let waitForIdleCalls = 0;
      const statuses: Array<[string, string | undefined]> = [];
      const notifications: Array<[string, string | undefined]> = [];
      const entries: Array<{ customType: string; data: any }> = [];
      let rendererType: string | undefined;
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      const fakePi = {
        registerEntryRenderer: (customType: string) => {
          rendererType = customType;
        },
        appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
        registerCommand: (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      };
      registerAgyCommand(fakePi as unknown as ExtensionAPI);

      try {
        const task = `inspect files ${"carefully ".repeat(80)}`;
        await handler!(`plan flash agent=gsd-debugger ${task}`, {
          mode: "tui",
          cwd: workDir,
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
        assert.equal(rendererType, "agy-run-receipt");
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.customType, "agy-run-receipt");
        assert.equal(entries[0]!.data.text, "direct result");
        assert.equal(entries[0]!.data.details.mode, "plan");
        assert.equal(entries[0]!.data.details.agent, "gsd-debugger");
        const invocations = await readFakeAgyArgs(bin);
        assert.ok(invocations.some((argv) => hasFlagPair(argv, "--agent", "gsd-debugger")));
        assert.ok(entries[0]!.data.task.length <= 500);
        assert.match(entries[0]!.data.completed_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(!notifications.some(([message]) => message.includes("direct result")));
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    });
  });

  it("falls back to a notification when custom entries are unavailable", async () => {
    const raw = JSON.stringify({
      event: "result",
      result: { response: "fallback result", status: "SUCCESS" },
    });
    await withFakeAgy(raw, async () => {
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      registerAgyCommand({
        registerCommand: (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      } as unknown as ExtensionAPI);
      const notifications: Array<[string, string | undefined]> = [];
      await handler!("plan flash fallback task", {
        mode: "tui",
        cwd: process.cwd(),
        waitForIdle: async () => {},
        ui: {
          setStatus: () => {},
          notify: (message: string, type?: "info" | "warning" | "error") =>
            notifications.push([message, type]),
        },
      } as unknown as ExtensionCommandContext);
      assert.ok(notifications.some(([message, type]) => message.includes("fallback result") && type === "info"));
    });
  });

  it("reports an aborted direct run as cancellation and appends no receipt", async () => {
    await withFakeAgy("", async () => {
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      const entries: unknown[] = [];
      registerAgyCommand({
        appendEntry: (_customType: string, data: unknown) => entries.push(data),
        registerCommand: (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      } as unknown as ExtensionAPI);
      const controller = new AbortController();
      controller.abort();
      const notifications: Array<[string, string | undefined]> = [];
      await handler!("plan flash cancelled task", {
        mode: "tui",
        cwd: process.cwd(),
        signal: controller.signal,
        waitForIdle: async () => {},
        ui: {
          setStatus: () => {},
          notify: (message: string, type?: "info" | "warning" | "error") =>
            notifications.push([message, type]),
        },
      } as unknown as ExtensionCommandContext);
      assert.deepEqual(notifications.at(-1), ["agy: cancelled", "info"]);
      assert.equal(entries.length, 0);
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
              agent: "gsd-debugger",
              updated_at: new Date().toISOString(),
              summary: "fix git conflicts",
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
        const entries: Array<{ customType: string; data: any }> = [];
        const fakePi = {
          appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
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
          "1. fix git conflicts · flash-medium · agent gsd-debugger · just now · conv-111…",
          "accept-edits — writes files (default)",
        ]);
        const args = await readFakeAgyArgs(bin);
        assert.ok(args.some((argv) => hasFlagPair(argv, "--conversation", "conv-1111")));
        assert.ok(args.some((argv) => hasFlagPair(argv, "--agent", "gsd-debugger")));
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.customType, "agy-run-receipt");
        assert.match(entries[0]!.data.text, /^resumed(?:\n|$)/);
        assert.ok(!notifications.some(([message]) => message.includes("resumed")));
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

  it("parses and preserves a custom agent name", () => {
    const parsed = parseAgyCommandArgs("plan agent=GSD-Debugger review the crash");
    assert.equal(parsed.agent, "GSD-Debugger");
    assert.equal(parsed.prompt, "review the crash");
    assert.match(parseAgyCommandArgs("agent= plan task").error ?? "", /must not be empty/);
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

  it("parses bounded context modes among leading options", () => {
    const parsed = parseAgyCommandArgs("context=summary plan sonnet review the decision");
    assert.equal(parsed.context, "summary");
    assert.equal(parsed.mode, "plan");
    assert.equal(parsed.model, "sonnet");
    assert.equal(parsed.prompt, "review the decision");
  });

  it("rejects unknown context modes before they become prompt text", () => {
    const parsed = parseAgyCommandArgs("context=everything plan inspect");
    assert.equal(parsed.error, "unknown context mode 'everything'");
    assert.equal(parsed.prompt, "inspect");
  });
});


