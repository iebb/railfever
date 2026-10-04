// Fixtures and full-state assertions shared by the section tests.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize } from '../src/game/save';
import { arcTable, bezLine, bezReverse, type Bez } from '../src/game/geom';
import { PSTEP } from '../src/game/constants';
import { flatGame, check, done } from './stationlib';
import { planRailSection, commitRailSectionPlan, type RailSectionBuildOptions } from '../src/game/rail-section-ops';
import type { TrackCount } from '../src/game/rail-section-types';
export { assert, flatGame, check, done };

export function scenario(name: string, test: () => void) {
  try { test(); check(true, name); } catch (e) { check(false, `${name}: ${(e as Error).stack}`); }
}
export function rawRail(g: Game, bez = bezLine(24, 64, 112, 64), opts: { owner?: number; type?: string; y?: number; reverse?: boolean; prof?: Float32Array } = {}) {
  const n = g.world.net, b = opts.reverse ? bezReverse(bez) : bez, len = arcTable(b).len;
  const prof = opts.prof ?? new Float32Array(Math.max(2, Math.ceil(len / PSTEP) + 1)).fill(opts.y ?? 3);
  const a = n.addNode('rail', b.x0, prof[0], b.z0), z = n.addNode('rail', b.x3, prof.at(-1)!, b.z3);
  return n.addEdge('rail', a.id, z.id, b, prof, [], opts.type ?? 'standard', opts.owner ?? 0);
}
export function opts(count: TrackCount = 1): RailSectionBuildOptions {
  return { kind: 'rail', type: 'standard', tracks: count, owner: 0, heightOffset: 0, crossing: 'auto' };
}
export function authored(g: Game, count: TrackCount = 1, curved = false) {
  const a = { kind: 'free' as const, x: 24, y: 3, z: 64 }, b = { kind: 'free' as const, x: 112, y: 3, z: curved ? 112 : 64 };
  const p = planRailSection(g, a, b, { ...opts(count), ...(curved ? { tangents: { start: { x: 1, z: 0 }, end: { x: 0, z: 1 } } } : {}) });
  assert.equal(p.ok, true, p.error); const before = g.economy.money, result = commitRailSectionPlan(g, p); assert.equal(result.error, null);
  assert.equal(before - g.economy.money, p.cost);
  return g.railSections.get(result.section!)!;
}
const map = (m: Map<unknown, unknown>) => [...m];
/** Serialized state plus unsaved versions/dirty sets, index order, RNG and allocator state. */
export function state(g: Game) {
  const net = g.world.net as any, w = g.world as any, s = g.railSections;
  return JSON.stringify({ save: serialize(g), net: { version: net.version, nodes: [...net.nodes.values()], edges: [...net.edges.keys()],
    gridCells: map(net.grid.cells), gridBoxes: map(net.grid.boxes), nodeCells: map(net.nodeGrid.cells), nodeBoxes: map(net.nodeGrid.boxes),
    dirty: [[...net.dirtyEdges], [...net.dirtyNodes]], ids: [net.nextNode, net.nextEdge, net.nextCrossing], roads: [net.roadVersions.version, net.frontageRoadVersions.version] },
    world: { h: Array.from(w.h), lock: Array.from(w.lock), dirty: [[...w.dirtyObj], [...w.dirtyTerrain]], heightVersion: w.heightsVersion,
      terrain: [w.terrainVersions.version, w.frontageTerrainVersions.version, map(w.terrainVersions.cells)], lots: [w.lotVersions.version, map(w.lotChanges)],
      chunks: [Array.from(w.saveHeightVersions), w.saveTreeVersions], treeCells: map(w.treeGrid.cells), free: w.freeTrees },
    section: [s.version, s.nextSection, s.nextSlot, s.nextJunction, s.nextStructure, [...s.byEdge.keys()]],
    rng: g.rng.state, gameNetwork: [g.networkVersion, (g as any).networkDirty], reservations: map((g.vehicles as any).res) });
}
export function physical(g: Game) {
  const d = serialize(g); delete d.net.railSections; return JSON.stringify(d);
}
