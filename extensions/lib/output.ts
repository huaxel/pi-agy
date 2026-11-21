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
  const markerFor = (omitted: number) => `${markerPrefix}${omitted}${markerSuffix}`;

  // The omitted count depends on how much room the marker itself takes, and the
  // marker's width depends on the omitted count's digits. Reserving space from
  // the first estimate and then reporting the larger true count crosses a power
  // of ten with the reserved width, and the result came back one character over
  // the cap this helper promises. Iterate to the fixed point instead; digits
  // grow at most a few times before it settles.
  let marker = markerFor(text.length - max);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const available = max - marker.length;
    if (available <= 0) return text.slice(0, max);
    const headLength = Math.ceil(available / 2);
    const tailLength = available - headLength;
    const handled = headLength + tailLength;
    const next = markerFor(text.length - handled);
    if (next.length === marker.length) {
      return text.slice(0, headLength) + next + (tailLength > 0 ? text.slice(-tailLength) : "");
    }
    marker = next;
  }
  // Unreachable with sane inputs; never return more than asked for.
  return text.slice(0, max);
}
