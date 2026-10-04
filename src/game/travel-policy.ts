/** Saved policy; stage 2 uses physical-v1 only for read-only shadow queries. */
export const LEGACY_POLICY = 'legacy' as const;
export const PHYSICAL_POLICY = 'physical-v1' as const;
export type TravelPolicy = typeof LEGACY_POLICY | typeof PHYSICAL_POLICY;
export type LegacyPolicy = typeof LEGACY_POLICY;
/** Quantize a primitive once; route sums remain exact safe integers. */
export function timeMs(seconds: number): number {
  const ms = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid travel time');
  return ms;
}
export function restoreTravelPolicy(value: unknown): TravelPolicy {
  return value === PHYSICAL_POLICY ? PHYSICAL_POLICY : LEGACY_POLICY;
}
