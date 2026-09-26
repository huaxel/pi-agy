export { detectVerifyCommand, detectVerifyCommandFromPackageJson } from "./verify.js";
export { parseJsonResponse } from "./parse.js";

export type AgyModel =
  | "flash-low"
  | "flash-medium"
  | "flash-high"
  | "pro-low"
  | "pro-high"
  | "sonnet"
  | "opus"
  | "gpt-oss";

export const AGY_MODEL_ALIASES: readonly AgyModel[] = [
  "flash-low",
  "flash-medium",
  "flash-high",
  "pro-low",
  "pro-high",
  "sonnet",
  "opus",
  "gpt-oss",
];

export function isAgyModel(value: unknown): value is AgyModel {
  return typeof value === "string" && (AGY_MODEL_ALIASES as readonly string[]).includes(value);
}

export type AgyEffort = "low" | "medium" | "high";

export type { AgyQuotaEntry, AgyUsageSnapshot } from "./usage.js";

export interface AgyOptions {
  prompt: string;
  model?: AgyModel;
  tier?: "flash" | "flash-lo" | "pro";
  effort?: AgyEffort;
  /** Optional custom agent name passed to `agy --agent`. */
  agent?: string;
  mode?: "plan" | "accept-edits" | "sandbox";
  dir: string;
  timeout_ms: number;
  conversation_id?: string;
  continue?: boolean;
  stream?: boolean;
  skipPermissions?: boolean;
}

export type { AgyModelCatalog } from "./inspect.js";
export {
  checkAgyConnectivity,
  checkAgyHealth,
  checkAgyUsage,
  getModelCatalog,
  inspectAgyAgents,
  inspectAgyModels,
  inspectAgyVersion,
  isStableModelId,
  normalizeAgyAgentName,
  parseAgyAgents,
  parseModelCatalog,
  resetModelCatalog,
  updateModelCatalog,
} from "./inspect.js";
export { isTransientAgyFailure } from "./retry.js";
export {
  buildAgyArgs,
  buildAgyPrompt,
  resolveAgyModelAlias,
  resolveAgyModelId,
  supportsAgyEffort,
} from "./args.js";

export { findAgyQuotaEntries, formatAgyUsage, isAgyQuotaExhausted, parseAgyUsage } from "./usage.js";

export { killProcessTree } from "./spawn.js";

export function getAgyConversationId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const conversationId = (error as { conversation_id?: unknown }).conversation_id;
  return typeof conversationId === "string" ? conversationId : undefined;
}

export { spawnAgy, spawnAgyStream } from "./spawn.js";
