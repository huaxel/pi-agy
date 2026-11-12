import { isAgyModel, type AgyModel } from "./cli.js";
import { validateAgyModelId, type AgyModelId } from "./provider-models.js";

/** Keep closed aliases exhaustive; concrete IDs are a separate, exclusive selector. */
export type AgyModelSelector =
  | { model?: AgyModel; tier?: "flash" | "flash-lo" | "pro"; model_id?: never }
  | { model_id: AgyModelId; model?: never; tier?: never };

/** Interactive runs always have an explicit selection; executor callers may use defaults. */
export type AgyModelSelection = AgyModelSelector & ({ model: AgyModel } | { model_id: AgyModelId });

export function validateModelSelector(selection: AgyModelSelector): void {
  if (selection.model_id !== undefined) {
    validateAgyModelId(selection.model_id);
    if (selection.model !== undefined || selection.tier !== undefined) {
      throw new Error("agy model_id cannot be combined with model or tier");
    }
  }
}

/** Legacy provider keys may be slugified: never guess a distorted hyphenated ID. */
export function storedModelSelection(value: unknown, rawModelId?: unknown): AgyModelSelection | undefined {
  try {
    if (rawModelId !== undefined) return { model_id: validateAgyModelId(rawModelId) };
    if (isAgyModel(value)) return { model: value };
    const id = validateAgyModelId(value);
    // Dots cannot come from Pi slugification; bare IDs survive it unchanged.
    if (id.includes(".") || !id.includes("-")) return { model_id: id };
  } catch { /* Missing or malformed legacy metadata requires explicit selection. */ }
  return undefined;
}
