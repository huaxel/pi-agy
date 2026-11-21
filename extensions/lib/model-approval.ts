/**
 * Model resolution for approval-gated runs.
 *
 * `accept-edits` shows the user a model before it writes anything, and both the
 * dialog and the spawned process need the same answer. Resolving twice does not
 * give that: `executeAgyTask` runs a preflight that refreshes the shared model
 * catalog, so an alias approved as one id can spawn as another after the
 * refresh. Resolve once, before the prompt, and carry the concrete id through
 * as `model_id` so nothing downstream can re-resolve it.
 */

import { requireAgyModelId, resolveAgyModelId } from "./args.js";
import type { AgyModel, AgyOptions } from "./cli.js";
import { inspectAgyModels } from "./inspect.js";
import { validateAgyModelId, type AgyModelId } from "./provider-models.js";

export interface ModelApprovalRequest {
  /** Already-concrete id from the caller; returned unchanged. */
  modelId?: string;
  model?: AgyModel;
  tier?: AgyOptions["tier"];
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Resolve the alias to the id the user is about to approve.
 *
 * A cold catalog is refreshed once here, so the dialog never displays a
 * resolved-looking alias next to an `undefined` id. When the alias still
 * resolves to nothing, the error names the alias and the recovery instead of
 * asking for approval and failing later. `undefined` means "no explicit
 * selection": the configured default model decides, and it is not this
 * function's place to override it with a catalog snapshot.
 */
export async function resolveModelForApproval(
  request: ModelApprovalRequest,
): Promise<AgyModelId | undefined> {
  if (request.modelId) return validateAgyModelId(request.modelId);
  // No explicit selection: the configured default decides, and pinging that
  // here would override slower-moving config with a catalog snapshot.
  if (request.model === undefined && request.tier === undefined) return undefined;
  const known = resolveAgyModelId(request.model, request.tier);
  if (known) return validateAgyModelId(known);
  await inspectAgyModels(request.cwd, request.signal).catch(() => undefined);
  return validateAgyModelId(requireAgyModelId(request.model, request.tier));
}
