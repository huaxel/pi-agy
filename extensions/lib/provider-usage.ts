/**
 * Native token usage validation, session-cumulative differencing, and
 * Pi `Usage` normalization for Antigravity provider turns.
 *
 * Verified against live `agy --output-format stream-json`:
 * - `input_tokens` excludes `cache_read_tokens`.
 * - `output_tokens` includes `thinking_tokens` (matching Pi's `reasoning` subset).
 * - In persistent `--input-format stream-json` mode, `result.usage` is
 *   cumulative across turns in the process session, so consecutive turns
 *   subtract the previous committed baseline to avoid double-counting.
 */

export interface ValidatedAgyUsage {
  input: number;
  output: number;
  cacheRead: number;
  thinking?: number;
}

export interface NormalizedProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
}

export const ZERO_USAGE_BASELINE: Readonly<ValidatedAgyUsage> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  thinking: 0,
});

function parseNonNegSafeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value === 0 ? 0 : value;
}

/**
 * Validate a raw `agy` usage object without coercion, rounding, or clamping.
 * Returns `undefined` when absent or when any recognized own field is invalid.
 */
export function validateAgyUsage(raw: unknown): ValidatedAgyUsage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;

  if (!Object.hasOwn(record, "input_tokens") || !Object.hasOwn(record, "output_tokens")) {
    return undefined;
  }
  const input = parseNonNegSafeInt(record.input_tokens);
  const output = parseNonNegSafeInt(record.output_tokens);
  if (input === undefined || output === undefined) return undefined;

  let cacheRead = 0;
  if (Object.hasOwn(record, "cache_read_tokens") && record.cache_read_tokens !== undefined) {
    const parsed = parseNonNegSafeInt(record.cache_read_tokens);
    if (parsed === undefined) return undefined;
    cacheRead = parsed;
  }

  let thinking: number | undefined;
  if (Object.hasOwn(record, "thinking_tokens") && record.thinking_tokens !== undefined) {
    const parsed = parseNonNegSafeInt(record.thinking_tokens);
    if (parsed === undefined) return undefined;
    thinking = parsed;
  }

  if (Object.hasOwn(record, "total_tokens") && record.total_tokens !== undefined) {
    if (parseNonNegSafeInt(record.total_tokens) === undefined) return undefined;
  }

  return thinking !== undefined
    ? { input, output, cacheRead, thinking }
    : { input, output, cacheRead };
}

/**
 * Difference a cumulative session usage snapshot against a known same-generation
 * baseline. Returns `undefined` on counter regression or safe-integer overflow.
 */
export function diffAgyUsage(
  current: ValidatedAgyUsage,
  baseline: ValidatedAgyUsage,
): NormalizedProviderUsage | undefined {
  const input = current.input - baseline.input;
  const output = current.output - baseline.output;
  const cacheRead = current.cacheRead - baseline.cacheRead;
  if (input < 0 || output < 0 || cacheRead < 0) return undefined;

  let reasoning: number | undefined;
  // Both sides must know their thinking counter. Treating a missing baseline as
  // zero would charge the whole cumulative session's reasoning to this turn;
  // ZERO_USAGE_BASELINE states its zero explicitly for exactly that reason.
  if (current.thinking !== undefined && baseline.thinking !== undefined) {
    const deltaThinking = current.thinking - baseline.thinking;
    if (deltaThinking < 0) return undefined;
    if (deltaThinking <= output) {
      reasoning = deltaThinking === 0 ? 0 : deltaThinking;
    }
  }

  const totalTokens = input + output + cacheRead;
  if (!Number.isSafeInteger(totalTokens)) return undefined;

  return {
    input: input === 0 ? 0 : input,
    output: output === 0 ? 0 : output,
    cacheRead: cacheRead === 0 ? 0 : cacheRead,
    cacheWrite: 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: totalTokens === 0 ? 0 : totalTokens,
  };
}
