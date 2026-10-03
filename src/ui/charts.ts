// Consistent canvas charts: grid with value labels, bar and line series, month ticks.
import { fmtMoney } from '../game/economy';

/** `dash`: a dashed line (a second cue beside the colour, e.g. mail income). */
export interface Series { values: number[]; color: string; kind?: 'line' | 'bar'; label?: string; dash?: number[] }

export interface ChartOpts {
  w?: number;
  h?: number;
  /** x tick labels (same length as the series) */
  labels?: string[];
  fmt?: (v: number) => string;
}

const FONT = '500 11px "Inter", system-ui, sans-serif';

/** Render a chart into a new canvas (sized in CSS pixels, crisp on HiDPI). */
export function chart(series: Series[], opts: ChartOpts = {}): HTMLCanvasElement {
  const W = opts.w ?? 520, H = opts.h ?? 150;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const cv = document.createElement('canvas');
  cv.className = 'chart';
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.height = H + 'px';
  // a data signature lets the window refresh skip unchanged charts
  cv.setAttribute('data-sig', series.map((s) => s.values.map((v) => Math.round(v)).join(',') + s.color).join('|'));
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.scale(dpr, dpr);
  const fmt = opts.fmt ?? fmtMoney;
  const n = Math.max(1, ...series.map((s) => s.values.length));
  let lo = 0, hi = 0;
  for (const s of series) for (const v of s.values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1) hi = lo + 1;
  const padL = 46, padR = 8, padT = 10, padB = opts.labels ? 18 : 8;
  const cw = W - padL - padR, ch = H - padT - padB;
  // nice grid step
  const raw = (hi - lo) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const Y = (v: number) => padT + ch - ((v - lo) / (hi - lo)) * ch;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  for (let v = lo; v <= hi + step * 0.01; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = Math.abs(v) < step * 0.01 ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(164,175,191,0.9)';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(v), padL - 6, y);
  }
  const bw = cw / n;
  const bars = series.filter((s) => s.kind === 'bar');
  bars.forEach((s, si) => {
    const w = Math.max(2, (bw - 4) / bars.length);
    s.values.forEach((v, i) => {
      const x = padL + i * bw + 2 + si * w;
      const y0 = Y(0), y1 = Y(v);
      ctx.fillStyle = v >= 0 ? s.color : '#ff6b6b';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, Math.min(y0, y1), w - 1, Math.max(1, Math.abs(y1 - y0)));
    });
  });
  ctx.globalAlpha = 1;
  for (const s of series) {
    if (s.kind === 'bar' || !s.values.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    s.values.forEach((v, i) => { const x = padL + i * bw + bw / 2, y = Y(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.setLineDash([]);
    const li = s.values.length - 1;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(padL + li * bw + bw / 2, Y(s.values[li]), 3, 0, Math.PI * 2); ctx.fill();
  }
  if (opts.labels) {
    ctx.fillStyle = 'rgba(125,136,154,0.95)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const every = Math.max(1, Math.ceil(n / 8));
    opts.labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) ctx.fillText(l, padL + i * bw + bw / 2, H - 5); });
  }
  return cv;
}
