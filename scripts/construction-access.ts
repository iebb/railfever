// A native construction quote cannot retain rights which ended before its commit.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { planEdge, commitProposal, findSnap, type BuildOptions, type Snap, type Proposal } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';

const free = (x: number, z: number): Snap => ({ kind: 'free', x, z, y: 4 });
const options = (owner: number, extra: Partial<BuildOptions> = {}): BuildOptions =>
  ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra });
function fixture(kind: 'rail' | 'road' = 'rail', owner = 1, tram = false) {
  const g = Game.create({ size: 128, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 2 });
  g.aiEnabled = false; g.world.h.fill(4); g.world.heightsVersion++;
  for (const co of g.companies) co.economy.money = 1e9;
  const opts = options(owner, { kind, type: kind === 'road' ? 'street' : 'standard', tram });
  const p = planEdge(g, free(20, 64), free(108, 64), opts);
  assert(p.ok, p.errors.join('; ')); assert.equal(commitProposal(g, p), null);
  return { g, opts };
}
function grant(g: Game, owner = 1, user = 0) {
  g.setAccessPolicy(owner, 'open'); assert.equal(g.requestAccess(user, owner), 'granted');
}
function deniedAtomically(g: Game, quote: Proposal, label: string) {
  const saved = serialize(g);
  for (const h of [g, deserialize(saved)]) {
    const before = JSON.stringify(serialize(h));
    assert.match(commitProposal(h, quote) ?? '', /needs track access/, `${label}: current authorization is required`);
    assert.equal(JSON.stringify(serialize(h)), before, `${label}: refusal preserves money, geometry, terrain and counters`);
  }
}

for (const kind of ['rail', 'road'] as const) for (const snapKind of ['node', 'edge'] as const) {
  const { g, opts } = fixture(kind, 1, kind === 'road'); grant(g);
  const start = findSnap(g, kind, snapKind === 'node' ? 108 : 64, 64, 0.1);
  assert.equal(start.kind, snapKind);
  const end = snapKind === 'node' ? free(122, 64) : free(112, 98);
  const build = options(0, { ...opts, owner: 0 }), quote = planEdge(g, start, end, build);
  assert(quote.ok, quote.errors.join('; ')); assert.equal(quote.opts.infrastructureOwner, undefined);
  g.blockCompany(1, 0); assert(!g.canUse(0, 1));
  const fresh = planEdge(g, start, end, build);
  assert(!fresh.ok && fresh.errors.some(e => /needs track access/.test(e)), 'native re-quote observes revoked endpoint rights');
  deniedAtomically(g, quote, `${kind} ${snapKind}`);
}

{
  const { g } = fixture(); grant(g);
  const quote = planEdge(g, free(64, 20), free(64, 108), options(0, { crossing: 'level' }));
  assert(quote.ok, quote.errors.join('; ')); assert(quote.crossings.some(c => c.mode === 'diamond'));
  g.blockCompany(1, 0); deniedAtomically(g, quote, 'native rail diamond');
}

for (const owner of [0, 1]) {
  const { g } = fixture('rail', owner); if (owner !== 0) grant(g, owner);
  const quote = planEdge(g, findSnap(g, 'rail', 108, 64, 0.1), free(122, 64), options(0));
  assert(quote.ok, quote.errors.join('; '));
  const old = [...g.world.net.edges.values()][0], money = g.economy.money;
  assert.equal(commitProposal(g, quote), null, 'lawful ordinary own/authorized connections still commit');
  assert.equal(old.owner, owner, 'joined infrastructure retains its owner');
  assert.equal(money - g.economy.money, quote.cost, 'only the native quoted cost is charged');
}

{
  const { g } = fixture(); g.blockCompany(1, 0); assert(!g.canUse(0, 1));
  const quote = planEdge(g, free(64, 20), free(64, 108), options(0, { crossing: 'over' }));
  assert(quote.ok, quote.errors.join('; ')); assert(quote.crossings.some(c => c.mode === 'over'));
  assert.equal(commitProposal(g, quote), null, 'lawful grade-separated foreign rail crossings require no access');
}

{
  const { g } = fixture('road', 1, true); g.blockCompany(1, 0);
  const quote = planEdge(g, free(64, 20), free(64, 108), options(0, { kind: 'road', type: 'street' }));
  assert(quote.ok, quote.errors.join('; ')); assert(quote.crossings.some(c => c.mode === 'junction'));
  assert.equal(commitProposal(g, quote), null, 'public road junctions do not require access to the existing tram operator');
}

{
  const { g } = fixture('rail', 0); grant(g, 0, 1);
  const quote = planEdge(g, findSnap(g, 'rail', 108, 64, 0.1), free(122, 64), options(1, { infrastructureOwner: 0 }));
  assert(quote.ok, quote.errors.join('; '));
  const before = JSON.stringify(serialize(g));
  assert.match(commitProposal(g, quote) ?? '', /cannot upgrade the player's track/, 'retained-infrastructure policy remains stricter than ordinary access');
  assert.equal(JSON.stringify(serialize(g)), before);
}
console.log('PASS native revoked node/edge/tram/diamond quotes refuse atomically live/cold; authorized, own, public-road and separated construction remain lawful');
