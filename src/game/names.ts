import { RNG } from './rng';

const PRE = [
  'Ash', 'Brook', 'Cold', 'Dun', 'East', 'Fair', 'Glen', 'High', 'Iron', 'King', 'Lang', 'Mill', 'North',
  'Oak', 'Pen', 'Quarry', 'Red', 'Stan', 'Thorn', 'Upper', 'Wil', 'West', 'Wick', 'Bram', 'Carl', 'Elm',
  'Fox', 'Green', 'Hart', 'Lin', 'Mar', 'New', 'Old', 'Rock', 'South', 'Stone', 'Sun', 'Wood', 'Black',
  'White', 'Kirk', 'Bel', 'Chal', 'Dor', 'Grant', 'Hay', 'Lock', 'Pres', 'Rad', 'Shel', 'Tam', 'Wey',
];
const SUF = [
  'ford', 'bury', 'ton', 'ham', 'field', 'wick', 'stead', 'worth', 'ley', 'by', 'mouth', 'chester',
  'bridge', 'well', 'dale', 'combe', 'haven', 'minster', 'port', 'holm', 'thorpe', 'gate', 'brook',
  'moor', 'cliff', 'den', 'hurst', 'stow', 'mere', 'ridge', 'wood', 'side', 'castle', 'burgh', 'cott',
];

export function townName(rng: RNG, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    let n = rng.pick(PRE) + rng.pick(SUF);
    if (rng.chance(0.08)) n = rng.pick(['Great ', 'Little ', 'Upper ', 'Lower ', 'Port ', 'St. ']) + n;
    else if (rng.chance(0.06)) n = n + rng.pick([' Green', ' Heath', ' Cross', ' Bay', ' Vale', ' Hill']);
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = 'Town ' + (used.size + 1);
  used.add(n);
  return n;
}
