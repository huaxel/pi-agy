import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_OBSERVED_SUBAGENTS,
  formatAgySubagentObservations,
  formatAgySubagentProgress,
  observeAgySubagents,
} from "../extensions/lib/subagents.js";

describe("observed agy subagents", () => {
  it("folds captured native ACTIVE and DONE records without claiming live state", () => {
    const active = {
      step_index: 2,
      state: "ACTIVE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: {
        subagents: [{
          type_name: "research",
          role: "File Counter",
          initial_prompt: "Count files in the current directory.",
        }],
      },
    };
    let observed = observeAgySubagents(undefined, active);
    assert.deepEqual(observed, [{
      step_index: 2,
      slot: 0,
      name: "File Counter",
      type: "research",
      task: "Count files in the current directory.",
      status: "active",
      duration_seconds: undefined,
      error: undefined,
    }]);
    assert.equal(
      formatAgySubagentProgress(active),
      "▸ subagent File Counter — Count files in the current directory.",
    );

    observed = observeAgySubagents(observed, {
      ...active,
      state: "DONE",
      duration_seconds: 0.145,
      subagent_info: { subagents: [] },
    });
    assert.equal(observed?.[0]?.status, "done");
    assert.equal(observed?.[0]?.duration_seconds, 0.145);
    assert.match(formatAgySubagentObservations(observed) ?? "", /File Counter · done · 0\.1s/);
  });

  it("tracks parallel records in one step and sanitizes bounded details", () => {
    const observed = observeAgySubagents(undefined, {
      step_index: 8,
      state: "ACTIVE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: {
        subagents: [
          { role: "\u001b[31mResearcher\u001b[0m", initial_prompt: "x".repeat(300) },
          { role: "Reviewer", type_name: "code" },
        ],
      },
    });
    assert.equal(observed?.length, 2);
    assert.equal(observed?.[0]?.name, "Researcher");
    assert.equal(observed?.[0]?.task?.length, 120);
    assert.equal(formatAgySubagentProgress({
      step_index: 8,
      state: "DONE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: { subagents: [{ role: "Researcher" }, { role: "Reviewer" }] },
    }), "✓ subagent Researcher +1 completed");
  });

  it("supports legacy tool-form spawn records and ignores unrelated subagent tools", () => {
    const observed = observeAgySubagents(undefined, {
      step_index: 4,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_subagent",
      tool_info: { parameters: { Name: "worker", Task: "review auth" } },
    });
    assert.equal(observed?.[0]?.name, "worker");
    assert.equal(observed?.[0]?.task, "review auth");
    const messageStep = {
      step_index: 5,
      state: "ACTIVE",
      step_type: "subagent",
      tool_name: "send_message",
      subagent_info: { subagents: [{ role: "ghost", initial_prompt: "status?" }] },
    };
    assert.equal(observeAgySubagents(observed, messageStep)?.length, 1);
    assert.equal(formatAgySubagentProgress(messageStep), undefined);
  });

  it("reads nested legacy spawn arrays and correlates without a step index", () => {
    let observed = observeAgySubagents(undefined, {
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: {
        parameters: {
          Subagents: [{ Name: "planner", Type: "design", Task: "draft a plan" }],
        },
      },
    });
    assert.equal(observed?.[0]?.name, "planner");
    assert.equal(observed?.[0]?.task, "draft a plan");
    observed = observeAgySubagents(observed, {
      state: "DONE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      duration_seconds: 3,
      tool_info: { parameters: { Subagents: [{ Name: "planner" }] } },
    });
    assert.equal(observed?.length, 1);
    assert.equal(observed?.[0]?.status, "done");
    assert.equal(observed?.[0]?.duration_seconds, 3);
  });

  it("marks errors and caps the observation roster", () => {
    const many = Array.from({ length: MAX_OBSERVED_SUBAGENTS + 10 }, (_, index) => ({
      role: `worker-${index}`,
    }));
    let observed = observeAgySubagents(undefined, {
      step_index: 1,
      state: "ACTIVE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: { subagents: many },
    });
    assert.equal(observed?.length, MAX_OBSERVED_SUBAGENTS);
    const report = formatAgySubagentObservations(observed) ?? "";
    assert.equal(report.split("\n").length, 14);
    assert.match(report, /20 more in structured details$/);
    observed = observeAgySubagents(observed, {
      step_index: 1,
      state: "ERROR",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      error: { message: "quota\nexhausted" },
      subagent_info: { subagents: [] },
    });
    assert.ok(observed?.every((entry) => entry.status === "error"));
    assert.ok(observed?.every((entry) => entry.error === "quota exhausted"));
  });

  it("labels unfinished entries as active only at the last observed event", () => {
    const report = formatAgySubagentObservations([{
      slot: 0,
      name: "worker",
      status: "active",
    }]);
    assert.match(report ?? "", /active at last event/);
    assert.ok(!(report ?? "").includes("running"));
  });
});
