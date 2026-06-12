/**
 * Tiny semver helpers. Avoids adding a full semver package — we only
 * need: compare two versions, check ordering, check "greater than or
 * equal to", and check a string is well-formed.
 */

export const parseVersion = (v: string): [number, number, number] | null => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

export const isValidVersion = (v: string): boolean => parseVersion(v) !== null;

export const semverCompare = (a: string, b: string): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const ma = pa[0]!;
  const mb = pa[1]!;
  const mc = pa[2]!;
  const na = pb[0]!;
  const nb = pb[1]!;
  const nc = pb[2]!;
  if (ma !== na) return ma - na;
  if (mb !== nb) return mb - nb;
  if (mc !== nc) return mc - nc;
  return 0;
};

export const semverGte = (a: string, b: string): boolean => semverCompare(a, b) >= 0;
export const semverLte = (a: string, b: string): boolean => semverCompare(a, b) <= 0;
