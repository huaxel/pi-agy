/**
 * Model-id ordering for catalog resolution.
 *
 * Split out of `lib/cli.ts`: pure string comparison with no process or
 * catalog state, so it can be tested and reasoned about in isolation.
 */

/**
 * Order model ids so the newest-looking id wins catalog resolution.
 * Returns a negative/zero/positive number like `Array.prototype.sort` expects.
 */
export function compareModelIds(a: string, b: string): number {
  if (!b) return 1;
  const versionA = /^gemini-(\d+(?:\.\d+)*)-/.exec(a)?.[1];
  const versionB = /^gemini-(\d+(?:\.\d+)*)-/.exec(b)?.[1];
  if (versionA && versionB) return compareDottedVersions(versionA, versionB);
  // Numeric-aware compare so claude-sonnet-4-10 sorts above claude-sonnet-4-6.
  return compareNatural(a, b);
}

function compareNatural(a: string, b: string): number {
  const sa = a.split(/(\d+)/);
  const sb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const pa = sa[i] ?? "";
    const pb = sb[i] ?? "";
    if (pa === pb) continue;
    if (/^\d+$/.test(pa) && /^\d+$/.test(pb)) {
      const na = Number(pa);
      const nb = Number(pb);
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return pa < pb ? -1 : 1;
  }
  return 0;
}

function compareDottedVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
