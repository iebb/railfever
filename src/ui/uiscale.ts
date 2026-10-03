// Interface size (Settings → Interface): the HUD, cards, windows, the title screen and in-world labels are drawn at
// 90–130 %. The stylesheet zooms them by the --uis custom property (CSS zoom lays them out again at the new size, so
// text stays sharp — no transform scaling); script-placed popups zoom their contents. Remembered in this browser.
export const UI_SCALES = [0.9, 1, 1.15, 1.3] as const;
const KEY = 'railfever.uiscale';

let scale = 1;
const listeners: ((previous: number) => void)[] = [];

/** Current interface scale (1 = 100 %). Script coordinates on zoomed elements are divided by it. */
export function uiScale(): number { return scale; }

/** Called after the scale changes, with the previous scale (windows keep their place on screen). */
export function onUiScale(fn: (previous: number) => void) { listeners.push(fn); }

function apply() {
  if (typeof document === 'undefined') return;
  const r = document.documentElement;
  r.style.setProperty('--uis', String(scale));
  // for layout breakpoints that move with the interface size (media queries cannot read --uis)
  r.dataset.uis = String(Math.round(scale * 100));
}

/** Set and remember the interface scale (snapped to the offered steps). */
export function setUiScale(s: number) {
  const v = UI_SCALES.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), 1 as number);
  if (v === scale) return;
  const old = scale;
  scale = v;
  apply();
  try { localStorage.setItem(KEY, String(v)); } catch { /* ignore */ }
  for (const fn of listeners) { try { fn(old); } catch (e) { console.error(e); } }
  // everything placed from measured layout (tool card above the dock, windows kept on screen, the renderer) is worked
  // out again, as after a window resize; the new zoom is already laid out when they measure
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('resize'));
}

// restore the remembered scale as soon as the UI modules load (before any window or the title screen is built)
try {
  const v = typeof localStorage !== 'undefined' ? Number(localStorage.getItem(KEY)) : NaN;
  if ((UI_SCALES as readonly number[]).includes(v)) scale = v;
} catch { /* ignore */ }
apply();
