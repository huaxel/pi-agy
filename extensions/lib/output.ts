const DEFAULT_MAX_OUTPUT_CHARS = 8000;

/** Human-facing relative age for an ISO timestamp ("5m ago", "2h ago", …). */
export function describeWhen(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown age";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function truncate(text: string, max = DEFAULT_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";

  const markerPrefix = "\n\n(Output truncated: ";
  const markerSuffix = " chars omitted)\n\n";
  let marker = `${markerPrefix}${text.length - max}${markerSuffix}`;
  const available = max - marker.length;
  if (available <= 0) return text.slice(0, max);

  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  const omitted = text.length - headLength - tailLength;
  marker = `${markerPrefix}${omitted}${markerSuffix}`;
  return (
    text.slice(0, headLength) +
    marker +
    (tailLength > 0 ? text.slice(-tailLength) : "")
  );
}
