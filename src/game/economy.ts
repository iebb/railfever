// Company finances.

/**
 * Finance categories. Vehicle operating costs (opcosts.ts): 'running' = fixed overheads (older saves: all running
 * costs), 'crew', 'energy', 'vehicleMaint'; infrastructure: 'maintenance' (base upkeep), 'trackWear' (wear by
 * train passages).
 */
export type Category = 'construction' | 'vehicles' | 'running' | 'crew' | 'energy' | 'vehicleMaint' | 'maintenance' | 'trackWear' | 'income' | 'interest' | 'trackIncome' | 'trackFees' | 'acquisition';
/** Report order: income first, then the expenses. */
export const CATEGORIES: Category[] = ['income', 'trackIncome', 'construction', 'vehicles', 'crew', 'energy', 'vehicleMaint', 'running', 'maintenance', 'trackWear', 'trackFees', 'interest', 'acquisition'];
export const CATEGORY_LABEL: Record<Category, string> = {
  income: 'Passenger income',
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
};
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
  return { income: 0, construction: 0, vehicles: 0, running: 0, crew: 0, energy: 0, vehicleMaint: 0, maintenance: 0, trackWear: 0, interest: 0, trackIncome: 0, trackFees: 0, acquisition: 0 };
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
    let s = 0;
    for (const k of CATEGORIES) if (k !== 'acquisition') s += v[k];
    return s;
  }
}

export interface Company {
  id: number;
  name: string;
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

/** Company colours: the player first, then up to 7 AI companies (mutually distinct hues). */
export const COMPANY_COLORS = ['#e8a33d', '#3d8be8', '#d6453d', '#47b36b', '#9a5fd6', '#22b8c2', '#e0609e', '#8a96a8'];

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
