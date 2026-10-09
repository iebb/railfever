// Floating, draggable window cards (bottom sheets on narrow screens) with throttled refresh.
import { h, icon } from './dom';
import { uiScale } from './uiscale';

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
  /** element that had the focus when the window opened (focus goes back there when it closes) */
  opener?: HTMLElement | null;
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

/** Up to this width the stylesheet anchors windows above the dock (and phones show them as bottom sheets). */
const DOCKED_LAYOUT = 1279;

export class WindowManager {
  wins = new Map<string, Win>();
  /** sound hooks (opening a new window / closing one) */
  sfx = { open: () => {}, close: () => {} };
  /** The dock, tool tray and tool card on screen (set by the HUD): windows above them end at their top. */
  below: { left: number; right: number; top: number }[] = [];
  private silent = false;
  private z = 100;
  private cascade = 0;
  constructor(private root: HTMLElement) {
    // (an interface-size change also arrives as a resize: windows grow with --uis)
    window.addEventListener('resize', () => this.keepOnScreen());
  }

  /** Keep every window wholly on screen (by its measured size; below the top bar where it fits). */
  private keepOnScreen() {
    const W = window.innerWidth, H = window.innerHeight, top = Math.round(60 * uiScale());
    for (const w of this.wins.values()) {
      const r = w.el.getBoundingClientRect();
      w.el.style.left = Math.max(0, Math.min(W - Math.min(r.width, W), r.left)) + 'px';
      w.el.style.top = Math.max(Math.min(top, Math.max(0, H - r.height)), Math.min(H - r.height - 8, r.top)) + 'px';
      this.fit(w);
    }
  }

  /** Re-fit every window's height (the dock or tray changed). */
  fitAll() { for (const w of this.wins.values()) this.fit(w); }

  /**
   * A window's height runs from its top to the dock below it (to the screen bottom beside the dock), so its own
   * scroll area holds the rest and the dock stays usable.
   */
  private fit(w: Win) {
    const el = w.el;
    if (window.innerWidth <= DOCKED_LAYOUT) { el.style.maxHeight = ''; return; }
    const top = parseFloat(el.style.top), left = parseFloat(el.style.left), width = el.offsetWidth;
    if (!Number.isFinite(top) || !Number.isFinite(left) || !width) return;
    let bottom = window.innerHeight - 10;
    for (const d of this.below) if (left < d.right && left + width > d.left && d.top > top) bottom = Math.min(bottom, d.top - 8);
    el.style.maxHeight = Math.max(200, Math.floor(bottom - top)) + 'px';
  }

  /**
   * Left edge for a new window beside the open ones: right-aligned, or next to an open window, where it covers the
   * least of the other windows and the left column (checklist, map card, minimap). Null: nothing open, cascade.
   */
  private slot(width: number, y: number): number | null {
    if (!this.wins.size || window.innerWidth <= DOCKED_LAYOUT) return null;
    const W = window.innerWidth, H = window.innerHeight, h = Math.min(560, H - y - 90);
    const rects = [...this.wins.values()].map((w) => w.el.getBoundingClientRect());
    const left = this.root.querySelector('.leftcol');
    const panels = left ? Array.from(left.children).map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0) : [];
    const cover = (x: number) => [...rects, ...panels].reduce((s, r) =>
      s + Math.max(0, Math.min(x + width, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top)), 0);
    const maxX = W - width - 16;
    let best: number | null = null, bestCover = Infinity;
    for (const x of [maxX, ...rects.flatMap((r) => [r.left - width - 10, r.right + 10])]) {
      if (x < 8 || x > maxX) continue;
      const c = cover(x);
      if (c < bestCover - 1 || (Math.abs(c - bestCover) <= 1 && best !== null && x > best)) { best = x; bestCover = c; }
    }
    // only worth it when the window ends up covering clearly less than it would stacked on the others
    return best !== null && bestCover < width * h * 0.35 ? Math.round(best) : null;
  }

  get narrow() { return window.innerWidth <= 720; }

  open(id: string, title: string, opts: WinOpts = {}): Win {
    const opener = document.activeElement;
    const ex = this.wins.get(id);
    if (ex) {
      ex.title.textContent = title;
      ex.el.setAttribute('aria-label', title);
      ex.sub.textContent = opts.sub ?? '';
      ex.refresh = opts.refresh;
      ex.onClose = opts.onClose;
      ex.body.innerHTML = '';
      ex.last = undefined;
      ex.tabsEl.innerHTML = '';
      ex.tabsEl.style.display = 'none';
      ex.tabsEl.dataset.sig = '';
      this.setHead(ex, opts);
      this.focus(ex);
      this.takeFocus(ex, opener);
      return ex;
    }
    const titleEl = h('span', { class: 'win-title' }, title);
    const subEl = h('span', { class: 'win-sub' }, opts.sub ?? '');
    const closeBtn = h('button', { class: 'ibtn win-x', 'data-tip': 'Close', 'data-key': 'Esc', 'data-sfx': 'none', 'aria-label': 'Close' }, icon('close', 18));
    const ic = h('span', { class: 'win-ic' }, icon(opts.icon ?? 'info', 17));
    const header = h('div', { class: 'win-head' }, ic, h('div', { class: 'win-tt' }, titleEl, subEl), closeBtn);
    const tabsEl = h('div', { class: 'win-tabs', role: 'tablist' });
    tabsEl.style.display = 'none';
    const body = h('div', { class: 'win-body' });
    // tabindex -1: the window itself takes the focus when it opens (Tab then walks its controls)
    const el = h('div', { class: 'win ' + (opts.cls ?? ''), role: 'dialog', 'aria-label': title, tabindex: '-1' }, header, tabsEl, body);
    const width = opts.width ?? 360;
    // the interface size (--uis) zooms the window's contents (style.css); its box grows with them
    el.style.width = `calc(${width}px * var(--uis, 1))`;
    const s = uiScale(), sw = width * s;
    const W = window.innerWidth, H = window.innerHeight;
    // beside the open windows where there is room, else cascaded over them
    const free = opts.x == null && opts.y == null ? this.slot(sw, 70 * s) : null;
    // (the cascade starts over once every window is closed: a lone window opens at the top, at full height)
    if (!this.wins.size) this.cascade = 0;
    const k = free == null ? this.cascade++ % 6 : 0;
    const x = Math.max(8, Math.min(W - sw - 10, opts.x ?? free ?? W - sw - 16 - k * 26));
    const y = Math.max(64 * s, Math.min(H - 320, opts.y ?? 70 * s + k * 26));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.root.appendChild(el);
    let closed = false;
    const win: Win = {
      id, el, body, title: titleEl, sub: subEl, tabsEl, tab: '', refresh: opts.refresh, onClose: opts.onClose,
      close: () => {
        if (closed) return;
        closed = true;
        if (this.wins.get(id) === win) this.wins.delete(id);
        win.onClose?.();
        if (!this.silent) this.sfx.close();
        if (el.contains(document.activeElement)) this.returnFocus(win);
        // fade / scale out, then remove
        el.classList.add('closing');
        setTimeout(() => el.remove(), 140);
      },
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
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.fit(win); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.wins.set(id, win);
    this.fit(win);
    this.focus(win);
    this.takeFocus(win, opener);
    if (!this.silent) this.sfx.open();
    return win;
  }

  /**
   * Move the keyboard focus into a window that opened (the window itself: it is labelled, and Tab continues with its
   * first control), remembering where it came from. Never taken away from a text field the player is typing in.
   */
  private takeFocus(w: Win, opener: Element | null) {
    if (typingIn(document.activeElement) || w.el.contains(document.activeElement)) return;
    // (re-opened from inside itself: keep the original opener)
    if (opener instanceof HTMLElement && opener !== document.body && !w.el.contains(opener)) w.opener = opener;
    w.el.focus({ preventScroll: true });
  }

  /** A window with the focus closed: back to its opener if that is still there, else to the window on top. */
  private returnFocus(w: Win) {
    const o = w.opener;
    if (!this.silent && o && o.isConnected && !o.closest('[inert], .win.closing') && o.getClientRects().length) { o.focus({ preventScroll: true }); return; }
    let top: Win | null = null, tz = -1;
    if (!this.silent) for (const x of this.wins.values()) { const z = Number(x.el.style.zIndex); if (x !== w && z > tz) { tz = z; top = x; } }
    if (top) top.el.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur?.();
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
  closeAll() {
    this.silent = true;
    for (const w of [...this.wins.values()]) w.close();
    this.silent = false;
  }

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

/** Is this element a text field (typing must keep its focus)? */
function typingIn(a: Element | null): boolean {
  if (!(a instanceof HTMLElement)) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
  return a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes((a as HTMLInputElement).type);
}

/**
 * Make everything beside `layer` in its parent inert (no focus, no clicks, hidden from assistive technology) while a
 * full-screen layer such as the title screen is open, including elements added meanwhile. Returns the undo.
 */
export function inertBehind(layer: HTMLElement): () => void {
  const root = layer.parentElement;
  if (!root) return () => {};
  const done: HTMLElement[] = [];
  const mark = (el: Element) => {
    if (el === layer || !(el instanceof HTMLElement) || el.hasAttribute('inert')) return;
    el.setAttribute('inert', '');
    done.push(el);
  };
  for (const el of Array.from(root.children)) mark(el);
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver((recs) => { for (const r of recs) r.addedNodes.forEach((n) => { if (n instanceof Element) mark(n); }); }) : null;
  mo?.observe(root, { childList: true });
  return () => {
    mo?.disconnect();
    for (const el of done) el.removeAttribute('inert');
    done.length = 0;
  };
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
