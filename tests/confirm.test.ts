import assert from "node:assert/strict";
import { it } from "node:test";

import { buildAcceptEditsConfirm } from "../extensions/lib/confirm.js";

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
