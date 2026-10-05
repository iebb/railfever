// New-game AI cash overrides, fifteen competitors, replacement ids and exact saves.
import { Game, MAX_AI_COMPANIES, TICK } from '../src/game/game';
import { aiConfigsFor } from '../src/ui/gameapi';
import { AI_PRESETS } from '../src/game/ai';
import { COMPANY_COLORS } from '../src/game/economy';
import { capacityTopologyKey } from '../src/game/rail-capacity-routes';
import { serialize, deserialize } from '../src/game/save';
import { check, fails } from './lib';

const options = { size: 128, seed: 7, towns: 0, hilliness: 'flat' as const, water: 'low' as const, startYear: 1980 };
const saved = (g: Game) => JSON.stringify(serialize(g));
const presets = JSON.stringify(AI_PRESETS);
const mixed = aiConfigsFor('mixed', MAX_AI_COMPANIES);
check(MAX_AI_COMPANIES > 7 && mixed.length === 15, 'new games support fifteen AI rivals');
check(mixed[0].startMoney === 5e6 && mixed[1].startMoney === 6e6 && mixed[2].startMoney === 4e6 && mixed[3].startMoney === 8e6,
  'blank balance retains existing mixed-personality amounts');
check(aiConfigsFor('mixed', 15, 12.5e6).every(c => c.startMoney === 12.5e6), 'custom starting balance applies to every rival');
check(aiConfigsFor('cautious', 1, 0)[0].startMoney === 0 && aiConfigsFor('aggressive', 1, 1e9)[0].startMoney === 1e9,
  'zero and billion-dollar balances are accepted');
check(aiConfigsFor('balanced', 1, -1)[0].startMoney === 0 && aiConfigsFor('balanced', 1, 2e9)[0].startMoney === 1e9,
  'config normalization retains the existing cash bounds');
check(JSON.stringify(AI_PRESETS) === presets, 'custom balances do not modify shared presets');
const g = Game.create({ ...options, aiCompanies: 15, aiConfigs: aiConfigsFor('mixed', 15, 12.5e6) });
g.aiEnabled = false; g.aiAcquisitions = false;
check(g.ais.length === 15 && g.activeCompanies.length === 16, 'all fifteen configured competitors are created');
check(g.ais.every(ai => ai.config.startMoney === 12.5e6 && g.company(ai.companyId).economy.money === 12.5e6
  && g.company(ai.companyId).economy.loan === 5e6), 'starting cash and existing loan rules are applied separately');
check(new Set(g.companies.map(c => c.name)).size === 16 && new Set(g.companies.map(c => c.color)).size === 16
  && new Set(g.companies.map(c => c.code)).size === 16 && COMPANY_COLORS.length >= 16, 'rivals have distinct names, colours and station codes');
let refused = false;
try { g.addAICompany(); } catch { refused = true; }
check(refused && !g.canAddAI() && g.companies.length === 16, 'adding a sixteenth AI is rejected without allocating an id');
const cold = deserialize(JSON.parse(saved(g)));
check(saved(g) === saved(cold), 'cash overrides, all fifteen configs and company identities save exactly');
let equal = true;
for (let tick = 0; tick < 640; tick++) { g.update(TICK); cold.update(TICK); if (saved(g) !== saved(cold)) { equal = false; break; } }
check(equal, 'fifteen-company games continue identically for 640 ticks after loading');
const configCount = Game.create({ ...options, aiConfigs: aiConfigsFor('balanced', 20, 2e6) });
check(configCount.ais.length === 15 && configCount.ais.every(ai => configCount.company(ai.companyId).economy.loan === 2e6),
  'oversized config lists stop at fifteen, and balances below five million borrow only that balance');
const replacement = Game.create({ ...options, aiConfigs: aiConfigsFor('balanced', 15, 0) });
replacement.economy.money = 1e8;
let replaced = true;
for (let i = 0; i < 23; i++) {
  const target = replacement.activeCompanies.find(c => c.ai)!;
  if (replacement.buyCompany(0, target.id) !== null || !replacement.canAddAI()) { replaced = false; break; }
  replacement.addAICompany({ startMoney: 0 });
}
check(replaced && replacement.activeCompanies.length === 16 && replacement.companies.at(-1)!.id > 32,
  'bought-out rivals may be replaced beyond id 32 while respecting the active-company limit');
const owner = replacement.companies.at(-1)!.id;
const before = capacityTopologyKey(replacement), unchanged = saved(replacement);
check(before === capacityTopologyKey(replacement) && unchanged === saved(replacement), 'capacity access keys are pure reads');
replacement.blockCompany(owner, 0);
check(!replacement.canUse(0, owner) && capacityTopologyKey(replacement) !== before, 'access changes for ids above 32 invalidate capacity routes');
replacement.unblockCompany(owner, 0);
const unblocked = capacityTopologyKey(replacement);
check(replacement.canUse(0, owner) && unblocked.slice(unblocked.indexOf('/') + 1) === before.slice(before.indexOf('/') + 1),
  'unblocking restores original permissions while keeping the topology revision');
check(saved(replacement) === saved(deserialize(JSON.parse(saved(replacement)))), 'replacement history and high-id permissions save exactly');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
