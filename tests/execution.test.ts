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
describe("resolveAgyMode", () => {
  it("defaults direct tool calls to accept-edits", () => {
    assert.equal(resolveAgyMode(), "accept-edits");
    assert.equal(resolveAgyMode("plan"), "plan");
  });
});

describe("extension registration", () => {
  it("registers the /agy command and the agy_execute tool", () => {
    const commands: string[] = [];
    const tools: Array<{ name: string; parameters?: unknown }> = [];
    const fakePi = {
      registerCommand: (name: string) => commands.push(name),
      registerTool: (tool: { name: string; parameters?: unknown }) => tools.push(tool),
    };
    piAgyExtension(fakePi as unknown as ExtensionAPI);
    assert.deepEqual(commands, ["agy"]);
    assert.equal(tools.length, 3);
    assert.equal(tools[0].name, "agy_execute");
    assert.equal(tools[1].name, "agy_history");
    assert.equal(tools[2].name, "agy_usage");
    assert.ok(tools[0].parameters);
    assert.ok(tools[1].parameters);
    assert.ok(tools[2].parameters);
  });

  it("lists recorded conversations through agy_history", async () => {
    type HistoryTool = {
      execute: (...args: any[]) => Promise<{
        content: Array<{ text: string }>;
        details: { dir: string; conversations: Array<{ conversation_id: string; summary?: string }> };
      }>;
    };
    let historyTool: HistoryTool | undefined;
    const fakePi = {
      registerCommand: () => {},
      registerTool: (tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => {
        if (tool.name === "agy_history" && tool.execute) {
          historyTool = tool as unknown as HistoryTool;
        }
      },
    };
    piAgyExtension(fakePi as unknown as ExtensionAPI);
    assert.ok(historyTool);

    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-workdir-"));
    await writeFile(
      path.join(agentDir, "agy-sessions.json"),
      JSON.stringify({
        [path.resolve(workDir)]: {
          last_conversation_id: "conv-1",
          last_model: "flash-low",
          updated_at: new Date().toISOString(),
          history: [
            {
              conversation_id: "conv-1",
              model: "flash-low",
              updated_at: new Date().toISOString(),
              summary: "fix git conflicts",
            },
            {
              conversation_id: "conv-2",
              model: "sonnet",
              updated_at: new Date(Date.now() - 3_600_000).toISOString(),
              summary: "review the auth diff",
            },
          ],
        },
      }),
    );
    try {
      const result = await historyTool!.execute("hist-1", {}, undefined, undefined, {
        cwd: workDir,
      });
      assert.match(result.content[0].text, new RegExp(`agy conversations for .*${workDir}`));
      assert.match(result.content[0].text, /conv-1/);
      assert.match(result.content[0].text, /flash-low · just now/);
      assert.match(result.content[0].text, /fix git conflicts/);
      assert.match(result.content[0].text, /sonnet · 1h ago/);
      assert.match(result.content[0].text, /review the auth diff/);
      assert.match(result.content[0].text, /Resume with agy_execute conversation_id/);
      assert.equal(result.details.conversations.length, 2);

      const limited = await historyTool!.execute("hist-2", { limit: 1 }, undefined, undefined, {
        cwd: workDir,
      });
      assert.equal(limited.details.conversations.length, 1);
      assert.equal(limited.details.conversations[0].conversation_id, "conv-1");

      const empty = await historyTool!.execute("hist-3", {}, undefined, undefined, {
        cwd: path.join(workDir, "subdir"),
      });
      assert.match(empty.content[0].text, /No agy conversations are recorded/);
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("reports targeted quota status through agy_usage", async () => {
    type UsageTool = {
      execute: (...args: any[]) => Promise<{
        content: Array<{ text: string }>;
        details: { quota_status?: string };
      }>;
    };
    let usageTool: UsageTool | undefined;
    const fakePi = {
      registerCommand: () => {},
      registerTool: (tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => {
        if (tool.name === "agy_usage" && tool.execute) {
          usageTool = tool as unknown as UsageTool;
        }
      },
    };
    piAgyExtension(fakePi as unknown as ExtensionAPI);
    const usage = JSON.stringify({
      quotas: [{ model: "claude-sonnet-4-6", remainingPercent: 0 }],
    });
    await withFakeAgy("{}", async () => {
      resetPreflightCache();
      const result = await usageTool!.execute(
        "usage-1",
        { model: "sonnet" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
      assert.equal(result.details.quota_status, "exhausted");
      assert.match(result.content[0].text, /selected model .*exhausted/);
    }, 0, 0, "", "", usage);
  });

  it("gates accept-edits behind the TUI confirmation dialog", async () => {
    type ExecuteTool = {
      execute: (...args: any[]) => Promise<any>;
    };
    let executeTool: ExecuteTool | undefined;
    const fakePi = {
      registerCommand: () => {},
      registerTool: (tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => {
        if (tool.name === "agy_execute" && tool.execute) {
          executeTool = tool as unknown as ExecuteTool;
        }
      },
    };
    piAgyExtension(fakePi as unknown as ExtensionAPI);
    assert.ok(executeTool);

    const params = {
      prompt: "write things",
      mode: "accept-edits",
      timeout_ms: 60_000,
    };

    // Headless runs must never reach agy with write permissions.
    await assert.rejects(
      executeTool!.execute("gate-1", params, undefined, undefined, {
        cwd: process.cwd(),
        hasUI: false,
      }),
      /accept-edits requires interactive confirmation/,
    );

    // A declined confirmation stops the run before spawning.
    await assert.rejects(
      executeTool!.execute("gate-2", params, undefined, undefined, {
        cwd: process.cwd(),
        hasUI: true,
        ui: { confirm: async () => false },
      }),
      /cancelled by user/,
    );
  });

  it("validates the agy_usage working directory before spawning", async () => {
    type UsageTool = {
      execute: (...args: any[]) => Promise<unknown>;
    };
    let usageTool: UsageTool | undefined;
    const fakePi = {
      registerCommand: () => {},
      registerTool: (tool: { name: string; execute?: (...args: any[]) => Promise<any> }) => {
        if (tool.name === "agy_usage" && tool.execute) {
          usageTool = tool as unknown as UsageTool;
        }
      },
    };
    piAgyExtension(fakePi as unknown as ExtensionAPI);
    assert.ok(usageTool);

    // A missing dir must not be misreported as a missing CLI installation.
    await assert.rejects(
      usageTool!.execute(
        "usage-dir-1",
        { dir: "/nonexistent/pi-agy-missing-dir" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
      /Working directory does not exist: /,
    );
    await assert.rejects(
      usageTool!.execute(
        "usage-dir-2",
        { dir: "package.json" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
      /Working directory is not a directory: /,
    );
  });
});


describe("shared executor", () => {
  it("includes refreshed model quota in the result", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "quota-aware", status: "SUCCESS" } }) +
      "\n";
    const usage = JSON.stringify({
      quotas: [
        {
          model: "gemini-3.8-flash-medium",
          remainingFraction: 0.42,
          resetTime: "2030-01-02T03:04:05Z",
        },
      ],
    });
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const result = await executeAgyTask(
        {
          prompt: "inspect quota before working",
          model: "flash-medium",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
      );

      assert.equal(result.details.quota?.models[0]?.remaining_fraction, 0.42);
      assert.equal(result.details.quota_status, "available");
      assert.match(result.text, /agy quota snapshot/);
      assert.match(result.text, /42% remaining/);
    }, 0, 0, "", "", usage);
  });

  it("fails clearly when the selected model quota is exhausted", async () => {
    const usage = JSON.stringify({
      quotas: [
        { model: "gemini-3.8-flash-medium", window: "five-hour", remainingFraction: 0.5 },
        { model: "gemini-3.8-flash-medium", window: "weekly", remainingFraction: 0, resetTime: 1_900_000_000 },
        { model: "claude-sonnet-4-6", window: "five-hour", remainingFraction: 0.8 },
      ],
    });
    await withFakeAgy("", async (bin) => {
      resetPreflightCache();
      await assert.rejects(
        executeAgyTask(
          {
            prompt: "do not spend quota",
            model: "flash-medium",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
        ),
        /quota exhausted.*gemini-3\.8-flash-medium.*alternatives: claude-sonnet-4-6/s,
      );
      const args = await readFakeAgyArgs(bin);
      assert.equal(args.filter((argv) => argv[0] === "-p").length, 0);
    }, 0, 0, "", "", usage);
  });

  it("runs agy directly and returns progress plus structured details", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "plan complete", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const progress: string[] = [];
      const result = await executeAgyTask(
        {
          prompt: "inspect the project",
          model: "flash-low",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
        (message) => progress.push(message),
      );

      assert.equal(result.text, "plan complete");
      assert.equal(result.details.mode, "plan");
      assert.equal(result.details.model, "flash-low");
      assert.equal(result.details.verify_cmd, null);
      assert.ok(progress.some((message) => message.includes("SUCCESS")));
    });
  });

  it("persists the effective fallback model for resumed sessions", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const raw = JSON.stringify({
      event: "result",
      result: { conversation_id: "fallback-conv", response: "done", status: "SUCCESS" },
    });
    try {
      await withFakeAgy(raw, async () => {
        resetPreflightCache();
        const result = await executeAgyTask(
          {
            prompt: "inspect the project",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
        );
        assert.equal(result.details.model, "flash-medium");
        const store = JSON.parse(await readFile(path.join(agentDir, "agy-sessions.json"), "utf8"));
        assert.equal(store[path.resolve(process.cwd())].last_model, "flash-medium");
        assert.equal(
          store[path.resolve(process.cwd())].history[0].summary,
          "inspect the project",
        );
      });
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("preserves JSON-shaped response text", async () => {
    const response = JSON.stringify({ response: "literal content", kind: "report" });
    const raw = JSON.stringify({
      event: "result",
      result: { response, status: "SUCCESS" },
    });
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const result = await executeAgyTask(
        {
          prompt: "inspect the project",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
      );
      assert.equal(result.text, response);
    });
  });

  it("marks responses served from a truncated raw stdout capture", async () => {
    // No result record and more than the raw capture bound: the verbatim
    // fallback must disclose the truncation instead of serving silently
    // cut text.
    const raw = "x".repeat(1_100_000) + "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const result = await executeAgyTask(
        {
          prompt: "emit plain text",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
      );
      assert.match(result.text, /\(raw stdout capture was truncated at the 1024 KB fallback bound\)$/);
    });
  });

  it("returns full json envelopes beyond the raw capture when stream is disabled", async () => {
    // --output-format json emits one top-level envelope record; it must
    // accumulate in-stream (uncapped by the raw fallback) no matter its size.
    const bigResponse = "y".repeat(100_000);
    const raw =
      JSON.stringify({
        response: bigResponse,
        conversation_id: "json-conv",
        duration_seconds: 3,
      }) + "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const result = await executeAgyTask(
        {
          prompt: "emit one big json envelope",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: false,
        },
        undefined,
      );
      assert.equal(result.text, bigResponse);
      assert.equal(result.details.conversation_id, "json-conv");
      assert.equal(result.details.duration_seconds, 3);
    });
  });

  it("parses an unterminated final stream record", async () => {
    const raw = JSON.stringify({
      event: "result",
      result: { response: "complete", status: "SUCCESS" },
    });
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const progress: string[] = [];
      const result = await executeAgyTask(
        {
          prompt: "inspect the project",
          model: "flash-low",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
        (message) => progress.push(message),
      );

      assert.equal(result.text, "complete");
      assert.ok(progress.some((message) => message.includes("SUCCESS")));
    });
  });

  it("persists the conversation when a run times out, keeping it resumable", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Emit the init record (with a conversation id), then hang past the
    // deadline — the failure-path save must survive the aborted signal.
    const raw = JSON.stringify({
      event: "init",
      conversation_id: "timeout-conv",
      init: { model: "fake" },
    });
    try {
      await withFakeAgy(
        raw,
        async () => {
          resetPreflightCache();
          await assert.rejects(
            executeAgyTask(
              {
                prompt: "hang after starting",
                mode: "plan",
                dir: process.cwd(),
                timeout_ms: 3_000,
                new_session: true,
                stream: true,
              },
              undefined,
            ),
            /timed out/,
          );
          const store = JSON.parse(
            await readFile(path.join(agentDir, "agy-sessions.json"), "utf8"),
          );
          const record = store[path.resolve(process.cwd())];
          assert.ok(record, "session store has a record for the directory");
          assert.equal(record.last_conversation_id, "timeout-conv");
        },
        0, // failures
        0, // delayMs
        "", // failureOutput
        "", // failureConversationId
        "{}", // usageOutput
        60_000, // hangAfterOutputMs — far past the 1.5s budget
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("returns a completed response even when the run is cancelled after delivery", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { conversation_id: "late-conv", response: "late but complete", status: "SUCCESS" },
      }) + "\n";
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await withFakeAgy(
        raw,
        async () => {
          resetPreflightCache();
          const controller = new AbortController();
          // Abort only once the result record has actually been delivered —
          // a fixed wall-clock delay races preflight on slow CI runners.
          const onProgress = (message: string) => {
            if (!controller.signal.aborted && message.includes("SUCCESS")) {
              controller.abort();
            }
          };
          const result = await executeAgyTask(
            {
              prompt: "finish then hang",
              mode: "plan",
              dir: process.cwd(),
              timeout_ms: 60_000,
              new_session: true,
              stream: true,
            },
            controller.signal,
            onProgress,
          );
          assert.match(result.text, /late but complete/);
          assert.match(result.text, /was cancelled; the completed result is preserved/);
          assert.equal(result.details.conversation_id, "late-conv");
          const store = JSON.parse(
            await readFile(path.join(agentDir, "agy-sessions.json"), "utf8"),
          );
          assert.equal(store[path.resolve(process.cwd())].last_conversation_id, "late-conv");
        },
        0, // failures
        0, // delayMs
        "", // failureOutput
        "", // failureConversationId
        "{}", // usageOutput
        60_000, // hangAfterOutputMs — the result arrives, then agy hangs
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("returns a completed response when the budget expires after delivery", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { conversation_id: "deadline-conv", response: "done at the wire", status: "SUCCESS" },
      }) + "\n";
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await withFakeAgy(
        raw,
        async () => {
          resetPreflightCache();
          const result = await executeAgyTask(
            {
              prompt: "finish then hang",
              mode: "plan",
              dir: process.cwd(),
              timeout_ms: 3_000,
              new_session: true,
              stream: true,
            },
            undefined,
          );
          assert.match(result.text, /done at the wire/);
          assert.match(result.text, /was timing out; the completed result is preserved/);
          assert.equal(result.details.conversation_id, "deadline-conv");
        },
        0, 0, "", "", "{}", 60_000,
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("reports user cancellation, not deadline expiry, when postflight is cut short", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { conversation_id: "postflight-conv", response: "edits complete", status: "SUCCESS" },
      }) + "\n";
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await withFakeAgy(
        raw,
        async () => {
          resetPreflightCache();
          const controller = new AbortController();
          // Event-driven abort (see the plan-mode variant above): the fixed
          // delay raced preflight on slow CI runners.
          const onProgress = (message: string) => {
            if (!controller.signal.aborted && message.includes("SUCCESS")) {
              controller.abort();
            }
          };
          const result = await executeAgyTask(
            {
              prompt: "finish then hang",
              mode: "accept-edits",
              dir: process.cwd(),
              timeout_ms: 60_000,
              new_session: true,
              stream: true,
            },
            controller.signal,
            onProgress,
          );
          assert.match(result.text, /edits complete/);
          assert.match(result.text, /diff summary skipped: the run was cancelled as agy finished/);
          assert.doesNotMatch(result.text, /reaching its deadline/);
          assert.match(result.text, /was cancelled; the completed result is preserved/);
          assert.equal(result.details.changed_files, undefined);
        },
        0, 0, "", "", "{}", 60_000,
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("reports the install hint when agy is missing from PATH", async () => {
    const emptyPath = await mkdtemp(path.join(os.tmpdir(), "pi-agy-nopath-"));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousPath = process.env.PATH;
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = emptyPath;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await assert.rejects(
        executeAgyTask(
          {
            prompt: "needs agy",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 30_000,
            new_session: true,
          },
          undefined,
        ),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return /not installed/.test(message) && /Install agy:/.test(message);
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      resetPreflightCache();
    }
  });

  it("rejects invalid session and timeout inputs before spawning agy", async () => {
    await assert.rejects(
      executeAgyTask(
        {
          prompt: "   ",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
        },
        undefined,
      ),
      /prompt must not be empty/,
    );
    await assert.rejects(
      executeAgyTask(
        {
          prompt: "inspect",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 0,
        },
        undefined,
      ),
      /timeout_ms must be a positive finite number/,
    );
    await assert.rejects(
      executeAgyTask(
        {
          prompt: "inspect",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          conversation_id: "conv-1",
          new_session: true,
        },
        undefined,
      ),
      /new_session cannot be combined/,
    );
    await assert.rejects(
      executeAgyTask(
        {
          prompt: "inspect",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          conversation_id: "conv-1",
          continue: true,
        },
        undefined,
      ),
      /--continue and --conversation together/,
    );
  });

  it("persists a conversation discovered before process failure", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await withFakeAgy(
        "",
        async () => {
          resetPreflightCache();
          await assert.rejects(
            executeAgyTask(
              {
                prompt: "edit the file",
                mode: "plan",
                dir: process.cwd(),
                timeout_ms: 60_000,
                new_session: true,
                stream: true,
              },
              undefined,
            ),
            /rate limit exceeded/,
          );
          const store = JSON.parse(await readFile(path.join(agentDir, "agy-sessions.json"), "utf8"));
          assert.equal(store[path.resolve(process.cwd())].last_conversation_id, "failed-conv");
        },
        2,
        0,
        "",
        "failed-conv",
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("does not retry after an unterminated tool activity record", async () => {
    const failureOutput = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "tool", state: "COMPLETED", tool_name: "edit_file" }
    });
    await withFakeAgy("", async () => {
      resetPreflightCache();
      const progress: string[] = [];
      await assert.rejects(
        executeAgyTask(
          {
            prompt: "edit the file",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
          (message) => progress.push(message),
        ),
        /rate limit exceeded/,
      );
      assert.ok(progress.some((message) => message.includes("working")));
      assert.ok(!progress.some((message) => message.includes("retrying")));
    }, 1, 0, failureOutput);
  });

  it("retries once after a transient failure before any work", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "recovered", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(
      raw,
      async () => {
        resetPreflightCache();
        const progress: string[] = [];
        const result = await executeAgyTask(
          {
            prompt: "inspect the project",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
          (message) => progress.push(message),
        );

        assert.equal(result.text, "recovered");
        assert.ok(progress.some((message) => message.includes("retrying")));
      },
      1,
    );
  });

  it("honors the legacy tier over a configured default", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    await writeFile(
      path.join(agentDir, "agy-config.json"),
      JSON.stringify({ defaultModel: "sonnet" }),
    );
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const raw =
        JSON.stringify({ event: "result", result: { response: "ok", status: "SUCCESS" } }) +
        "\n";
      await withFakeAgy(raw, async (bin) => {
        resetPreflightCache();
        const result = await executeAgyTask(
          {
            prompt: "inspect the project",
            tier: "pro",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
        );

        assert.equal(result.details.model, "pro-high");
        const args = await readFakeAgyArgs(bin);
        assert.ok(args.some((argv) => hasFlagPair(argv, "--model", "gemini-3.1-pro-high")));
      });
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("resolves the default model from the configured command", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-agentdir-"));
    await writeFile(
      path.join(agentDir, "agy-config.json"),
      JSON.stringify({ defaultModelCommand: "echo sonnet" }),
    );

    const raw =
      JSON.stringify({ event: "result", result: { response: "ok", status: "SUCCESS" } }) + "\n";
    await withFakeAgy(raw, async (bin) => {
      resetPreflightCache();
      resetDefaultModelCache();
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const result = await executeAgyTask(
          {
            prompt: "inspect the project",
            mode: "plan",
            dir: process.cwd(),
            timeout_ms: 60_000,
            new_session: true,
            stream: true,
          },
          undefined,
        );

        assert.equal(result.details.model, "sonnet");
        const args = await readFakeAgyArgs(bin);
        assert.ok(args.some((argv) => hasFlagPair(argv, "--model", "claude-sonnet-4-6")));
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
        resetDefaultModelCache();
      }
    });
  });

  it("enforces the timeout on the agy process", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "too late", status: "SUCCESS" } }) +
      "\n";
    await withFakeAgy(
      raw,
      async () => {
        resetPreflightCache();
        await assert.rejects(
          executeAgyTask(
            {
              prompt: "inspect the project",
              mode: "plan",
              dir: process.cwd(),
              timeout_ms: 100,
              new_session: true,
              stream: true,
            },
            undefined,
          ),
          /timed out after 100ms/,
        );
      },
      0,
      500,
    );
  });

  it("passes effort and disables slash expansion end to end", async () => {
    const raw =
      JSON.stringify({ event: "result", result: { response: "done", status: "SUCCESS" } }) + "\n";
    await withFakeAgy(raw, async (bin) => {
      resetPreflightCache();
      await executeAgyTask(
        {
          prompt: "/review then implement",
          model: "sonnet",
          effort: "high",
          mode: "plan",
          dir: process.cwd(),
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        undefined,
      );

      const args = await readFakeAgyArgs(bin);
      assert.ok(args.some((argv) => hasFlagPair(argv, "--effort", "high")));
      assert.ok(args.some((argv) => argv.includes("--disable-slash-commands")));
    });
  });
});


