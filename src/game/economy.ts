// Company finances.

/**
 * Finance categories. Income: 'income' (passenger fares), 'mailIncome' (mail, fares.ts mailFare). Vehicle operating
 * costs (opcosts.ts): 'running' = fixed overheads (older saves: all running costs), 'crew', 'energy', 'vehicleMaint';
 * infrastructure: 'maintenance' (base upkeep), 'trackWear' (wear by train passages).
 */
export type Category = 'construction' | 'vehicles' | 'running' | 'crew' | 'energy' | 'vehicleMaint' | 'maintenance' | 'trackWear' | 'income' | 'mailIncome' | 'interest' | 'trackIncome' | 'trackFees' | 'acquisition' | 'investments' | 'divestments' | 'dividends';
/** Report order: income first, then the expenses. */
export const CATEGORIES: Category[] = ['income', 'mailIncome', 'trackIncome', 'construction', 'vehicles', 'crew', 'energy', 'vehicleMaint', 'running', 'maintenance', 'trackWear', 'trackFees', 'interest', 'acquisition', 'investments', 'divestments', 'dividends'];
/**
 * Categories saved only once they hold money (added after save format 3 began): a game that never earned any saves
 * exactly as before, and older saves read them as 0 (Economy.fromJSON).
 */
const SPARSE_CATEGORIES: readonly Category[] = ['mailIncome'];
export const CATEGORY_LABEL: Record<Category, string> = {
  income: 'Passenger income',
  mailIncome: 'Mail income',
  trackIncome: 'Track access income',
  construction: 'Construction',
  vehicles: 'Vehicle purchases',
  crew: 'Crew wages',
  energy: 'Energy & fuel',
  vehicleMaint: 'Vehicle maintenance',
  running: 'Vehicle overheads',
  maintenance: 'Infrastructure maintenance',
  trackWear: 'Track wear',
  trackFees: 'Track access fees',
  interest: 'Loan interest',
  acquisition: 'Company acquisitions',
  investments: 'Share investments / funding',
  divestments: 'Share divestments / repurchases',
  dividends: 'Dividends received / paid',
};
/** Capital transfers and distributions are separate from the profit used for valuation and dividends. */
export const NON_PROFIT_CATEGORIES: Category[] = ['acquisition', 'investments', 'divestments', 'dividends'];
export const PROFIT_CATEGORIES = CATEGORIES.filter((k) => !NON_PROFIT_CATEGORIES.includes(k));
export function profitOf(v: Partial<Record<Category, number>>): number {
  return PROFIT_CATEGORIES.reduce((sum, k) => sum + (v[k] ?? 0), 0);
}
/** Operating costs (vehicles and infrastructure, access fees included): e.g. a "running & upkeep" chart line. */
export const OPERATING_COSTS: Category[] = ['crew', 'energy', 'vehicleMaint', 'running', 'maintenance', 'trackWear', 'trackFees'];
/** Sum of the operating cost categories of a record (negative: costs). */
export function operatingCosts(v: Record<Category, number>): number { let s = 0; for (const k of OPERATING_COSTS) s += v[k] ?? 0; return s; }

export const COSTS = {
  rail: 12000,
  road: 7000,
  terraform: 3500,
  tree: 500,
  bridgeRail: 70000,
  bridgeRoad: 45000,
  tunnelRail: 95000,
  tunnelRoad: 70000,
  levelCrossing: 12000,
  stationTile: 30000,
  busStop: 35000,
  depotRail: 90000,
  depotRoad: 60000,
  signal: 9000,
  removeRail: 2500,
  removeRoad: 1500,
  removeBuildingPerPop: 2500,
  maintRailPerTile: 600,      // per year
  maintRoadPerTile: 300,
  maintStationPerTile: 2500,
  maintStructurePerTile: 2000,
};

export interface MonthRecord { year: number; month: number; v: Record<Category, number> }

export function emptyRecord(): Record<Category, number> {
  return { income: 0, mailIncome: 0, construction: 0, vehicles: 0, running: 0, crew: 0, energy: 0, vehicleMaint: 0, maintenance: 0, trackWear: 0, interest: 0, trackIncome: 0, trackFees: 0, acquisition: 0, investments: 0, divestments: 0, dividends: 0 };
}
/** Fill categories missing in an older record with 0. */
function fullRecord(v: Partial<Record<Category, number>> | undefined): Record<Category, number> {
  const r = emptyRecord();
  if (v) for (const k of CATEGORIES) if (typeof v[k] === 'number') r[k] = v[k]!;
  return r;
}

export class Economy {
  money = 5_000_000;
  loan = 5_000_000;
  maxLoan = 25_000_000;
  loanStep = 500_000;
  interestRate = 0.04;
  current: Record<Category, number> = emptyRecord();
  months: MonthRecord[] = [];
  yearTotals: { year: number; v: Record<Category, number> }[] = [];
  thisYear: Record<Category, number> = emptyRecord();

  /** Restore from saved JSON (older saves lack some categories). */
  static fromJSON(d: any): Economy {
    const e = Object.assign(new Economy(), d ?? {});
    e.current = fullRecord(d?.current);
    e.thisYear = fullRecord(d?.thisYear);
    e.months = (d?.months ?? []).map((m: MonthRecord) => ({ year: m.year, month: m.month, v: fullRecord(m.v) }));
    e.yearTotals = (d?.yearTotals ?? []).map((y: { year: number; v: Record<Category, number> }) => ({ year: y.year, v: fullRecord(y.v) }));
    return e;
  }

  /** Saved form: records leave out the sparse categories while they are 0 (see SPARSE_CATEGORIES). */
  toJSON() {
    const rec = (v: Record<Category, number>): Partial<Record<Category, number>> => {
      if (SPARSE_CATEGORIES.every((k) => v[k])) return v;
      const out: Partial<Record<Category, number>> = {};
      for (const k of Object.keys(v) as Category[]) if (!SPARSE_CATEGORIES.includes(k) || v[k]) out[k] = v[k];
      return out;
    };
    return {
      ...this, current: rec(this.current), months: this.months.map((m) => ({ ...m, v: rec(m.v) })),
      yearTotals: this.yearTotals.map((y) => ({ ...y, v: rec(y.v) })), thisYear: rec(this.thisYear),
    };
  }

  canAfford(x: number) { return this.money >= x; }

  /** Spend money. Returns false (and spends nothing) if it can't be afforded and `force` is false. */
  spend(x: number, cat: Category, force = false): boolean {
    if (!force && x > this.money) return false;
    this.money -= x;
    this.current[cat] -= x;
    this.thisYear[cat] -= x;
    return true;
  }
  earn(x: number, cat: Category = 'income') {
    this.money += x;
    this.current[cat] += x;
    this.thisYear[cat] += x;
  }
  borrow(): boolean {
    if (this.loan + this.loanStep > this.maxLoan) return false;
    this.loan += this.loanStep;
    this.money += this.loanStep;
    return true;
  }
  repay(): boolean {
    const amt = Math.min(this.loanStep, this.loan);
    if (amt <= 0 || this.money < amt) return false;
    this.loan -= amt;
    this.money -= amt;
    return true;
  }
  endMonth(year: number, month: number) {
    this.spend((this.loan * this.interestRate) / 12, 'interest', true);
    this.months.push({ year, month, v: this.current });
    if (this.months.length > 36) this.months.shift();
    this.current = emptyRecord();
  }
  endYear(year: number) {
    this.yearTotals.push({ year, v: this.thisYear });
    if (this.yearTotals.length > 10) this.yearTotals.shift();
    this.thisYear = emptyRecord();
  }
  /** Cash minus loan (without assets; see Game.companyValue). */
  get netWorth() { return this.money - this.loan; }
  /** Profit of the last complete year (or of this year so far when there is none). */
  get lastYearProfit() {
    const y = this.yearTotals[this.yearTotals.length - 1];
    const v = y ? y.v : this.thisYear;
    return profitOf(v);
  }
}

export interface Company {
  id: number;
  name: string;
  /** Town hosting the company headquarters; stable across network growth and acquisitions. */
  hqTown?: number;
  color: string;
  ai: boolean;
  economy: Economy;
  /** bought by another company: kept for ids and history, hidden in the UI, owns nothing */
  defunct?: boolean;
  /** id of the company that bought this one */
  boughtBy?: number;
  /** one letter, unique among the companies (the X of JR-style station numbers XY01; see lines.ts) */
  code?: string;
}

/** Company colours: the player first, then fifteen AI rivals. Keep existing colours stable for saves. */
export const COMPANY_COLORS = ['#e8a33d', '#3d8be8', '#d6453d', '#47b36b', '#9a5fd6', '#22b8c2', '#e0609e', '#8a96a8',
  '#8ac926', '#6a5acd', '#c2185b', '#00897b', '#d4d4d8', '#a86b32', '#ed7544', '#b3cfed'];

export function fmtMoney(x: number): string {
  const neg = x < 0;
  x = Math.abs(x);
  let s: string;
  if (x >= 1e9) s = (x / 1e9).toFixed(2) + 'B';
  else if (x >= 1e6) s = (x / 1e6).toFixed(2) + 'M';
  else if (x >= 1e4) s = (x / 1e3).toFixed(0) + 'k';
  else s = Math.round(x).toLocaleString('en-US');
  return (neg ? '-$' : '$') + s;
}
export function fmtMoneyFull(x: number): string {
  return (x < 0 ? '-$' : '$') + Math.round(Math.abs(x)).toLocaleString('en-US');
}
