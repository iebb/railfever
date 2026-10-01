// Company finances.

export type Category = 'construction' | 'vehicles' | 'running' | 'maintenance' | 'income' | 'interest';
export const CATEGORIES: Category[] = ['income', 'construction', 'vehicles', 'running', 'maintenance', 'interest'];
export const CATEGORY_LABEL: Record<Category, string> = {
  income: 'Passenger income',
  construction: 'Construction',
  vehicles: 'Vehicle purchases',
  running: 'Vehicle running costs',
  maintenance: 'Infrastructure maintenance',
  interest: 'Loan interest',
};

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

function emptyRecord(): Record<Category, number> {
  return { income: 0, construction: 0, vehicles: 0, running: 0, maintenance: 0, interest: 0 };
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
  get netWorth() { return this.money - this.loan; }
}

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
