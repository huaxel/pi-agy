import assert from "node:assert/strict";
import { it } from "node:test";

import {
  buildAcceptEditsConfirm,
  buildContextForwardConfirm,
  needsContextConsent,
  requestContextConsent,
} from "../extensions/lib/confirm.js";

const base = {
  modelLabel: "flash-medium",
  cwd: "/workspace",
  prompt: "rename the helper",
  contextMode: "none",
  contextText: undefined,
  dirt: "clean",
};

it("names the verify command and the file that defines it", () => {
  // The command string is allowlisted, the code it runs is not: `just ci` is
  // whatever the checkout's justfile says. Approving the run approves that
  // code, so the dialog has to name both.
  const { body } = buildAcceptEditsConfirm({
    ...base,
    verify: { command: "just ci", definedIn: "justfile" },
  });
  assert.match(body, /^verify: just ci \(justfile\)$/m);
  assert.match(body, /including `just ci`, defined in justfile/);
});

it("omits the verify line when no verify loop applies", () => {
  const { body } = buildAcceptEditsConfirm({ ...base, verify: null });
  assert.doesNotMatch(body, /verify:/);
  assert.match(body, /run commands\.$/m);
});

it("shows the transcript excerpt the plan-mode run would forward", () => {
  // `plan` and `sandbox` write nothing, so they skip the accept-edits dialog by
  // design. Forwarding transcript text is not covered by that reasoning: the
  // text reaches an external CLI and its provider, and the call may have been
  // proposed by the model. The dialog has to name the mode and show what leaves.
  const { title, body } = buildContextForwardConfirm({
    mode: "plan",
    modelLabel: "flash-medium",
    cwd: "/workspace",
    contextMode: "recent",
    contextText: "x".repeat(500),
    background: false,
  });
  assert.equal(title, "Forward Pi transcript to agy (plan)?");
  assert.match(body, /^context: recent \(500 chars; text-only\)$/m);
  assert.match(body, /^excerpt: x{200}…$/m);
  assert.match(body, /plan writes nothing/);
  assert.match(body, /leaves this machine for the model provider/);
  assert.doesNotMatch(body, /detached/);
});

it("says a forwarded context outlives the dialog when the run is detached", () => {
  const { body } = buildContextForwardConfirm({
    mode: "sandbox",
    modelLabel: "default",
    agent: "reviewer",
    cwd: "/workspace",
    contextMode: "recent",
    contextText: undefined,
    background: true,
  });
  assert.match(body, /context: recent \(0 chars; no eligible text\)/);
  assert.match(body, /agent: reviewer/);
  assert.doesNotMatch(body, /excerpt:/);
  assert.match(body, /detached: this approval outlives the dialog/);
});

const consentInput = {
  mode: "plan",
  modelLabel: "flash-medium",
  cwd: "/workspace",
  contextMode: "recent",
  contextText: "earlier turn",
  background: false,
};

it("asks nothing when the transcript is not forwarded or the mode already did", () => {
  // accept-edits shows `context:` in its own approval, and `none` forwards
  // nothing at all: both would be a second question about the same thing.
  assert.equal(needsContextConsent("accept-edits", "recent"), false);
  assert.equal(needsContextConsent("plan", "none"), false);
  assert.equal(needsContextConsent("plan", "recent"), true);
  assert.equal(needsContextConsent("sandbox", "recent"), true);
});

it("refuses a silent-mode run that forwards context without a UI", async () => {
  // No UI means the question cannot be asked, so the content must not leave.
  await assert.rejects(
    requestContextConsent(consentInput, {
      hasUI: false,
      confirm: async () => true,
    }),
    /plan with context forwarding requires interactive confirmation/,
  );
});

it("does not run the turn when the forwarding dialog is declined", async () => {
  const asked: string[] = [];
  await assert.rejects(
    requestContextConsent(consentInput, {
      hasUI: true,
      confirm: async (title) => {
        asked.push(title);
        return false;
      },
    }),
    /plan cancelled by user/,
  );
  assert.deepEqual(asked, ["Forward Pi transcript to agy (plan)?"]);
});

it("lets the turn proceed when the forwarding dialog is approved", async () => {
  let asked = 0;
  await requestContextConsent(consentInput, {
    hasUI: true,
    confirm: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(asked, 1);
});
