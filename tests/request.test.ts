import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConversationSelection } from "../extensions/lib/request.js";

describe("normalizeConversationSelection", () => {
  // Exhaust every public combination, including empty IDs and explicit false.
  for (const conversation_id of [undefined, "", "explicit-id", " "]) {
    for (const resume of [undefined, false, true]) {
      for (const new_session of [undefined, false, true]) {
        const flags = { conversation_id, continue: resume, new_session };
        it(JSON.stringify(flags), () => {
          if (resume && conversation_id) {
            assert.throws(() => normalizeConversationSelection(flags), { message: "agy cannot use --continue and --conversation together" });
          } else if (new_session === true && (resume || conversation_id)) {
            assert.throws(() => normalizeConversationSelection(flags), { message: "agy new_session cannot be combined with a conversation to resume" });
          } else {
            const expected = conversation_id ? { kind: "resume", id: conversation_id }
              : resume ? { kind: "latest", source: "cli" }
                : new_session === false ? { kind: "latest", source: "recorded" }
                  : { kind: "new" };
            assert.deepEqual(normalizeConversationSelection(Object.freeze(flags)), expected);
          }
        });
      }
    }
  }
});
