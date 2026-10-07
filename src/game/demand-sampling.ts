/** Daily passenger generation uses a rotating quadrature on large connected networks. */
export const DEMAND_DESTINATION_LIMIT = 32;

interface Destination {
  id: number; x: number; z: number; townId: number; catchPop: number;
}
export interface DemandSample<T> { destination: T; weight: number }

/**
 * Keep two busy stops in each distance band; sample the other stops in stable spatial blocks. A selected stop
 * represents its block's destination count. The representative rotates by the saved day and origin ID, so no
 * route disappears permanently and no derived version, cache warmth or RNG changes a save's continuation.
 * Small networks retain every destination, in the original order, with the original exact weights.
 */
export function sampleDemandDestinations<T extends Destination>(from: Destination, day: number,
  destinations: T[]): DemandSample<T>[] {
  if (destinations.length <= DEMAND_DESTINATION_LIMIT)
    return destinations.map(destination => ({ destination, weight: 1 }));
  const groups: { destination: T; distance: number }[][] = [[], [], [], []];
  for (const destination of destinations) {
    const dx = destination.x - from.x, dz = destination.z - from.z, distance = dx * dx + dz * dz;
    const band = from.townId >= 0 && destination.townId === from.townId ? 0
      : distance < 60 * 60 ? 1 : distance < 130 * 130 ? 2 : 3;
    groups[band].push({ destination, distance });
  }
  // Reserve small bands in full. Distribute the remaining budget towards the largest unsampled bands.
  const counts = groups.map(group => Math.min(4, group.length));
  for (let left = DEMAND_DESTINATION_LIMIT - counts.reduce((a, b) => a + b, 0); left > 0; left--) {
    let best = -1, largest = 0;
    for (let i = 0; i < groups.length; i++) if (counts[i] < groups[i].length) {
      const ratio = groups[i].length / (counts[i] + 1);
      if (ratio > largest) { best = i; largest = ratio; }
    }
    if (best < 0) break;
    counts[best]++;
  }
  const result: DemandSample<T>[] = [];
  groups.forEach((group, band) => {
    if (!group.length) return;
    if (counts[band] === group.length) {
      for (const item of group) result.push({ destination: item.destination, weight: 1 });
      return;
    }
    group.sort((a, b) => b.destination.catchPop - a.destination.catchPop || a.destination.id - b.destination.id);
    for (const item of group.splice(0, 2)) result.push({ destination: item.destination, weight: 1 });
    group.sort((a, b) => a.destination.townId - b.destination.townId || a.distance - b.distance
      || a.destination.id - b.destination.id);
    const samples = counts[band] - 2, phase = day + from.id * 7 + band * 13;
    for (let i = 0; i < samples; i++) {
      const start = Math.floor(i * group.length / samples), end = Math.floor((i + 1) * group.length / samples);
      const weight = end - start, offset = ((phase % weight) + weight) % weight;
      result.push({ destination: group[start + offset].destination, weight });
    }
  });
  result.sort((a, b) => a.destination.id - b.destination.id);
  return result;
}
