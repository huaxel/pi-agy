const DEFAULT_MAX_OUTPUT_CHARS = 8000;

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
