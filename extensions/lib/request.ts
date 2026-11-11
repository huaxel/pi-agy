/** Pure interpretation of the public conversation-selection flags. */
export type ConversationSelection =
  | { kind: "new" }
  | { kind: "latest"; source: "cli" | "recorded" }
  | { kind: "resume"; id: string };

export interface ConversationFlags {
  conversation_id?: string;
  continue?: boolean;
  new_session?: boolean;
}

export function normalizeConversationSelection(flags: ConversationFlags): ConversationSelection {
  // Empty IDs have always behaved like an omitted ID; do not trim or coerce.
  if (flags.continue && flags.conversation_id) {
    throw new Error("agy cannot use --continue and --conversation together");
  }
  if (flags.new_session === true && (flags.continue || flags.conversation_id)) {
    throw new Error("agy new_session cannot be combined with a conversation to resume");
  }
  if (flags.conversation_id) return { kind: "resume", id: flags.conversation_id };
  if (flags.continue) return { kind: "latest", source: "cli" };
  if (flags.new_session === false) return { kind: "latest", source: "recorded" };
  return { kind: "new" };
}
