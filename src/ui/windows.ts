// Floating, draggable window cards (bottom sheets on narrow screens) with throttled refresh.
import { h, icon } from './dom';

export interface Win {
  id: string;
  el: HTMLDivElement;
  body: HTMLElement;
  title: HTMLSpanElement;
  sub: HTMLSpanElement;
  tabsEl: HTMLDivElement;
  /** current tab id (when tabs are used) */
  tab: string;
  refresh?: () => void;
  onClose?: () => void;
  close: () => void;
  /** last rendered markup (refreshes that produce the same markup are skipped) */
  last?: string;
}

export interface WinOpts {
  width?: number; x?: number; y?: number;
  icon?: string;
  /** accent colour of the header icon (mode / company colour) */
  color?: string;
  sub?: string;
  refresh?: () => void;
  onClose?: () => void;
  cls?: string;
}

export class WindowManager {
  wins = new Map<string, Win>();
  private z = 100;
  private cascade = 0;
  constructor(private root: HTMLElement) {
    window.addEventListener('resize', () => {
      for (const w of this.wins.values()) {
        const W = window.innerWidth, H = window.innerHeight;
        const r = w.el.getBoundingClientRect();
        w.el.style.left = Math.max(0, Math.min(W - Math.min(r.width, W), r.left)) + 'px';
        w.el.style.top = Math.max(60, Math.min(H - 80, r.top)) + 'px';
      }
    });
  }

  get narrow() { return window.innerWidth <= 720; }

  open(id: string, title: string, opts: WinOpts = {}): Win {
    const ex = this.wins.get(id);
    if (ex) {
      ex.title.textContent = title;
      ex.sub.textContent = opts.sub ?? '';
      ex.refresh = opts.refresh;
      ex.onClose = opts.onClose;
      ex.body.innerHTML = '';
      ex.last = undefined;
      ex.tabsEl.innerHTML = '';
      ex.tabsEl.style.display = 'none';
      this.setHead(ex, opts);
      this.focus(ex);
      return ex;
    }
    const titleEl = h('span', { class: 'win-title' }, title);
    const subEl = h('span', { class: 'win-sub' }, opts.sub ?? '');
    const closeBtn = h('button', { class: 'ibtn win-x', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('close', 18));
    const ic = h('span', { class: 'win-ic' }, icon(opts.icon ?? 'info', 17));
    const header = h('div', { class: 'win-head' }, ic, h('div', { class: 'win-tt' }, titleEl, subEl), closeBtn);
    const tabsEl = h('div', { class: 'win-tabs', role: 'tablist' });
    tabsEl.style.display = 'none';
    const body = h('div', { class: 'win-body' });
    const el = h('div', { class: 'win ' + (opts.cls ?? ''), role: 'dialog', 'aria-label': title }, header, tabsEl, body);
    const width = opts.width ?? 360;
    el.style.width = width + 'px';
    const W = window.innerWidth, H = window.innerHeight;
    const k = this.cascade++ % 6;
    const x = Math.max(8, Math.min(W - width - 10, opts.x ?? W - width - 16 - k * 26));
    const y = Math.max(64, Math.min(H - 320, opts.y ?? 70 + k * 26));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.root.appendChild(el);
    const win: Win = {
      id, el, body, title: titleEl, sub: subEl, tabsEl, tab: '', refresh: opts.refresh, onClose: opts.onClose,
      close: () => { el.remove(); this.wins.delete(id); win.onClose?.(); },
    };
    this.setHead(win, opts);
    closeBtn.addEventListener('click', win.close);
    el.addEventListener('pointerdown', () => this.focus(win));
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button') || this.narrow) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = el.offsetLeft, oy = el.offsetTop;
      const move = (ev: PointerEvent) => {
        el.style.left = Math.max(-el.offsetWidth + 80, Math.min(window.innerWidth - 80, ox + ev.clientX - sx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy)) + 'px';
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.wins.set(id, win);
    this.focus(win);
    return win;
  }

  private setHead(w: Win, opts: WinOpts) {
    const ic = w.el.querySelector('.win-ic') as HTMLElement | null;
    if (!ic) return;
    ic.style.setProperty('--c', opts.color ?? 'var(--accent)');
    ic.replaceChildren(icon(opts.icon ?? 'info', 17));
  }

  /** Tab bar under the header; clicking a tab re-renders the window. */
  setTabs(w: Win, tabs: [string, string][], render: () => void) {
    if (!w.tab || !tabs.some(([t]) => t === w.tab)) w.tab = tabs[0][0];
    const sig = tabs.map(([t, l]) => t + ':' + l).join('|') + '#' + w.tab;
    if (w.tabsEl.dataset.sig === sig) return;
    w.tabsEl.dataset.sig = sig;
    w.tabsEl.style.display = '';
    w.tabsEl.replaceChildren(...tabs.map(([t, label]) => h('button', {
      class: 'tab' + (t === w.tab ? ' on' : ''), role: 'tab', 'aria-selected': t === w.tab ? 'true' : 'false',
      onclick: () => { if (w.tab === t) return; w.tab = t; w.last = undefined; render(); },
    }, label)));
  }

  focus(w: Win) { w.el.style.zIndex = String(++this.z); }
  get(id: string) { return this.wins.get(id); }
  close(id: string) { this.wins.get(id)?.close(); }
  closeTop(): boolean {
    let top: Win | null = null, tz = -1;
    for (const w of this.wins.values()) { const z = Number(w.el.style.zIndex); if (z > tz) { tz = z; top = w; } }
    if (top) { top.close(); return true; }
    return false;
  }
  closeAll() { for (const w of [...this.wins.values()]) w.close(); }

  /** Re-render windows with a refresh function; unchanged markup is not touched. */
  refreshAll() {
    for (const w of this.wins.values()) {
      if (!w.refresh) continue;
      // keep focus inside inputs: skip refresh while typing
      const a = document.activeElement;
      if (a && w.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) continue;
      const real = w.body;
      const tmp = document.createElement('div');
      w.body = tmp;
      try { w.refresh(); } catch (e) { console.error(e); }
      w.body = real;
      const html = tmp.innerHTML;
      if (html === w.last) continue;
      w.last = html;
      morphChildren(real, tmp);
    }
  }
}

const REPLACE_TAGS = new Set(['BUTTON', 'A', 'SELECT', 'INPUT', 'CANVAS', 'TEXTAREA', 'LABEL']);
const CLICKABLE = /\b(row|model|chip|clickable|link|swatch|slot|tile)\b/;

/** Update `old` to match `nu`, keeping unchanged nodes (and their listeners) in place. */
function morph(old: Node, nu: Node) {
  if (old.nodeType !== nu.nodeType || old.nodeName !== nu.nodeName) { old.parentNode!.replaceChild(nu, old); return; }
  if (old.nodeType === Node.TEXT_NODE) { if (old.nodeValue !== nu.nodeValue) old.nodeValue = nu.nodeValue; return; }
  if (old.nodeType !== Node.ELEMENT_NODE) return;
  const o = old as HTMLElement, n = nu as HTMLElement;
  // interactive elements carry closures: replace them when anything about them changed
  if (REPLACE_TAGS.has(o.tagName) || CLICKABLE.test(typeof o.className === 'string' ? o.className : '')) {
    if (o.tagName === 'CANVAS' || o.outerHTML !== n.outerHTML) { o.parentNode!.replaceChild(n, o); }
    return;
  }
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  morphChildren(o, n);
}

export function morphChildren(o: HTMLElement, n: HTMLElement) {
  const oc = [...o.childNodes], nc = [...n.childNodes];
  for (let i = 0; i < nc.length; i++) {
    if (i < oc.length) morph(oc[i], nc[i]);
    else o.appendChild(nc[i]);
  }
  for (let i = nc.length; i < oc.length; i++) o.removeChild(oc[i]);
}
