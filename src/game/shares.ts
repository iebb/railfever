// Ten indivisible shares per company. AI share trading is deliberately not automatic: spare cash stays
// available for transport projects. The same trading API accepts player or AI company owners.
import type { Game } from './game';
import { profitOf } from './economy';

export const SHARE_COUNT = 10;
export const BUY_PREMIUM = 0.15;
export const CONTROL_PREMIUM_STEP = 0.05;
export const SELL_FEE = 0.10;
export const DIVIDEND_RATE = 0.30;

export interface ShareState {
  /** Company id -> number of shares (1..10); missing shares are free float. */
  shareholders: Record<number, number>;
  subsidiaryOf?: number;
  dividendYear?: number;
  /** Cash actually received by each shareholder at the last year end. */
  dividendsLastYear: Record<number, number>;
}

export interface ShareQuote {
  value: number;
  premium: number;
  premiumAmount: number;
  buyPrice: number;
  fee: number;
  feeAmount: number;
  sellPrice: number;
}

const money = (amount: number) => Math.round(amount * 100) / 100;

export class Shares {
  private states: Record<number, ShareState> = {};

  constructor(private game: Game) {}

  private state(target: number): ShareState {
    return this.states[target] ?? (this.states[target] = { shareholders: {}, dividendsLastYear: {} });
  }

  shareCount(owner: number, target: number): number { return this.states[target]?.shareholders[owner] ?? 0; }
  shareholders(target: number): { owner: number; shares: number }[] {
    return Object.entries(this.states[target]?.shareholders ?? {}).map(([owner, shares]) => ({ owner: Number(owner), shares }));
  }
  freeFloat(target: number): number { return SHARE_COUNT - this.shareholders(target).reduce((sum, h) => sum + h.shares, 0); }
  ownerOf(target: number): number | null { return this.shareholders(target).find((h) => h.shares === SHARE_COUNT)?.owner ?? null; }
  subsidiaryOf(target: number): number | null { return this.states[target]?.subsidiaryOf ?? null; }
  dividendYear(target: number): number | null { return this.states[target]?.dividendYear ?? null; }
  dividendLastYear(owner: number, target: number): number { return this.states[target]?.dividendsLastYear[owner] ?? 0; }
  dividendsPaidLastYear(target: number): number { return Object.values(this.states[target]?.dividendsLastYear ?? {}).reduce((sum, v) => sum + v, 0); }

  quote(owner: number, target: number): ShareQuote {
    const value = this.game.acquisitionValue(target) / SHARE_COUNT;
    const premium = BUY_PREMIUM + this.shareCount(owner, target) * CONTROL_PREMIUM_STEP;
    const buyPrice = money(value * (1 + premium)), sellPrice = money(value * (1 - SELL_FEE));
    return { value, premium, premiumAmount: money(buyPrice - money(value)), buyPrice, fee: SELL_FEE, feeAmount: money(money(value) - sellPrice), sellPrice };
  }

  private tradeError(owner: number, target: number): string | null {
    const b = this.game.companies[owner], t = this.game.companies[target];
    if (!b || !t || b.defunct || t.defunct) return 'No such active company';
    if (owner === target) return 'Cannot trade own shares';
    return null;
  }

  /** Full control must never create a cycle of companies owning each other. */
  private controlError(owner: number, target: number): string | null {
    const seen = new Set<number>();
    let id: number | null = owner;
    while (id !== null) {
      if (id === target || seen.has(id)) return 'Full ownership would create a control cycle';
      seen.add(id);
      id = this.ownerOf(id);
    }
    return null;
  }

  canInvest(owner: number, target: number): string | null {
    const err = this.tradeError(owner, target);
    if (err) return err;
    if (this.freeFloat(target) === 0) return 'No shares in the free float';
    if (this.shareCount(owner, target) === SHARE_COUNT - 1) {
      const control = this.controlError(owner, target);
      if (control) return control;
    }
    const price = this.quote(owner, target).buyPrice;
    if (!Number.isFinite(price) || price <= 0) return 'Shares have no tradable value';
    if (!this.game.companies[owner].economy.canAfford(price)) return 'Not enough cash to buy 10%';
    return null;
  }

  invest(owner: number, target: number): string | null {
    const err = this.canInvest(owner, target);
    if (err) return err;
    const quote = this.quote(owner, target);
    this.game.companies[owner].economy.spend(quote.buyPrice, 'investments');
    // Fund the share's base value; the premium is a real transaction charge, not recoverable on merge.
    this.game.companies[target].economy.earn(money(quote.value), 'investments');
    const s = this.state(target);
    s.shareholders[owner] = this.shareCount(owner, target) + 1;
    if (s.shareholders[owner] === SHARE_COUNT) {
      this.game.postNews(`${this.game.company(owner).name} owns 100% of ${this.game.company(target).name}; merge or keep as subsidiary.`, owner === 0 ? 'good' : 'ai');
    }
    return null;
  }

  canDivest(owner: number, target: number): string | null {
    const err = this.tradeError(owner, target);
    if (err) return err;
    if (this.shareCount(owner, target) === 0) return 'You own no shares to sell';
    const price = this.quote(owner, target).sellPrice;
    if (!Number.isFinite(price) || price <= 0) return 'Shares have no tradable value';
    if (!this.game.companies[target].economy.canAfford(money(this.quote(owner, target).value))) return 'Company lacks cash to repurchase 10%';
    return null;
  }

  divest(owner: number, target: number): string | null {
    const err = this.canDivest(owner, target);
    if (err) return err;
    const quote = this.quote(owner, target);
    // The shareholder receives the repurchase value less its fee; the fee leaves the companies' cash.
    this.game.companies[target].economy.spend(money(quote.value), 'divestments');
    this.game.companies[owner].economy.earn(quote.sellPrice, 'divestments');
    const s = this.state(target), count = s.shareholders[owner] - 1;
    if (count) s.shareholders[owner] = count; else delete s.shareholders[owner];
    delete s.subsidiaryOf;
    return null;
  }

  canMerge(owner: number, target: number): string | null {
    const err = this.tradeError(owner, target);
    if (err) return err;
    if (!this.game.companies[target].ai) return 'Player company cannot be a subsidiary or merged';
    if (this.shareCount(owner, target) !== SHARE_COUNT) return 'Needs 100% ownership to merge or keep as subsidiary';
    return this.controlError(owner, target);
  }

  keepAsSubsidiary(owner: number, target: number): string | null {
    const err = this.canMerge(owner, target);
    if (err) return err;
    const s = this.state(target);
    if (s.subsidiaryOf === owner) return null;
    s.subsidiaryOf = owner;
    this.game.postNews(`${this.game.company(target).name} operates as a subsidiary of ${this.game.company(owner).name}.`, owner === 0 ? 'good' : 'ai');
    return null;
  }

  /** Legacy full buyouts remain available only when no company's existing stake would be overwritten. */
  canBuyout(owner: number, target: number): string | null {
    if (this.shareCount(owner, target) === SHARE_COUNT) return this.canMerge(owner, target);
    if (this.freeFloat(target) !== SHARE_COUNT) return 'Merge needs 100%; existing shareholders keep shares';
    return this.controlError(owner, target);
  }

  /** Called by Game after paying for a legacy full buyout, immediately before its merge. */
  recordBuyout(owner: number, target: number) { this.state(target).shareholders[owner] = SHARE_COUNT; }

  /** Cancel the merged company's stock; its stakes elsewhere are assets transferred to the buyer. */
  onMerge(owner: number, target: number) {
    for (const [id, s] of Object.entries(this.states)) {
      if (Number(id) === target) { s.shareholders = {}; delete s.subsidiaryOf; continue; }
      const count = s.shareholders[target] ?? 0;
      delete s.shareholders[target];
      // The acquired company's holding in its buyer becomes free float, never self-owned shares.
      if (count && Number(id) !== owner) s.shareholders[owner] = (s.shareholders[owner] ?? 0) + count;
      if (s.subsidiaryOf === target) {
        if (Number(id) !== owner && s.shareholders[owner] === SHARE_COUNT) s.subsidiaryOf = owner;
        else delete s.subsidiaryOf;
      }
    }
  }

  /** Called before economies close the year. Snapshot every payout first: holdings/order cannot compound it. */
  payDividends(year: number) {
    const payments: { target: number; amounts: Record<number, number> }[] = [];
    for (const co of this.game.activeCompanies) {
      const s = this.state(co.id);
      if (s.dividendYear !== undefined && s.dividendYear >= year) continue;
      const holders = this.shareholders(co.id).filter((h) => !this.game.company(h.owner).defunct);
      const owned = holders.reduce((sum, h) => sum + h.shares, 0);
      const pool = Math.max(0, profitOf(co.economy.thisYear)) * DIVIDEND_RATE * owned / SHARE_COUNT;
      const cents = Math.floor(Math.max(0, Math.min(pool, co.economy.money)) * 100);
      const amounts: Record<number, number> = {};
      // Allocate whole cents pro rata, then remaining cents by largest remainder (company id breaks ties).
      const parts = holders.map((h) => ({ ...h, exact: cents * h.shares / owned, cents: Math.floor(cents * h.shares / owned) }));
      let remaining = cents - parts.reduce((sum, h) => sum + h.cents, 0);
      parts.sort((a, b) => (b.exact - b.cents) - (a.exact - a.cents) || a.owner - b.owner);
      for (const h of parts) { if (remaining > 0) { h.cents++; remaining--; } amounts[h.owner] = h.cents / 100; }
      payments.push({ target: co.id, amounts });
    }
    for (const p of payments) {
      const s = this.state(p.target);
      s.dividendYear = year;
      s.dividendsLastYear = p.amounts;
      for (const [owner, amount] of Object.entries(p.amounts)) {
        if (!amount) continue;
        this.game.company(p.target).economy.spend(amount, 'dividends', true);
        this.game.company(Number(owner)).economy.earn(amount, 'dividends');
      }
    }
  }

  toJSON(): Record<number, ShareState> {
    return Object.fromEntries(Object.entries(this.states).map(([id, s]) => [id, {
      shareholders: { ...s.shareholders }, dividendsLastYear: { ...s.dividendsLastYear },
      ...(s.subsidiaryOf !== undefined ? { subsidiaryOf: s.subsidiaryOf } : {}),
      ...(s.dividendYear !== undefined ? { dividendYear: s.dividendYear } : {}),
    }]));
  }

  /** Old saves have no share state. Valid saved ownership is restored without rounding or redistribution. */
  load(data: any) {
    this.states = {};
    if (!data || typeof data !== 'object') return;
    for (const [id, raw] of Object.entries(data) as [string, any][]) {
      const target = Number(id), co = this.game.companies[target];
      if (!co || !raw || typeof raw !== 'object') continue;
      const s: ShareState = { shareholders: {}, dividendsLastYear: {} };
      let total = 0;
      if (!co.defunct) for (const [key, count] of Object.entries(raw.shareholders ?? {})) {
        const owner = Number(key), b = this.game.companies[owner];
        if (!b || b.defunct || owner === target || typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || total + count > SHARE_COUNT) continue;
        s.shareholders[owner] = count;
        total += count;
      }
      for (const [key, amount] of Object.entries(raw.dividendsLastYear ?? {})) {
        if (this.game.companies[Number(key)] && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) s.dividendsLastYear[Number(key)] = amount;
      }
      if (typeof raw.subsidiaryOf === 'number' && s.shareholders[raw.subsidiaryOf] === SHARE_COUNT) s.subsidiaryOf = raw.subsidiaryOf;
      if (typeof raw.dividendYear === 'number' && Number.isInteger(raw.dividendYear)) s.dividendYear = raw.dividendYear;
      this.states[target] = s;
    }
  }
}
