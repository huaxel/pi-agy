/** Parse agy --output-format json responses; fall back to raw on schema drift. */
export function parseJsonResponse(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "response" in parsed) {
      const response = (parsed as { response?: unknown }).response;
      if (typeof response === "string") return response;
    }
  } catch {
    // Raw text is a valid fallback when the CLI schema changes.
  }
  return raw;
}
