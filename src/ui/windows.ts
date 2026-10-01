// Floating, draggable windows with periodic refresh.
import { h } from './dom';

export interface Win {
  id: string;
  el: HTMLDivElement;
  body: HTMLElement;
  title: HTMLSpanElement;
  refresh?: () => void;
  onClose?: () => void;
  close: () => void;
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
        w.el.style.top = Math.max(44, Math.min(H - 60, r.top)) + 'px';
      }
    });
  }

  open(id: string, title: string, opts: { width?: number; x?: number; y?: number; refresh?: () => void; onClose?: () => void; cls?: string } = {}): Win {
    const ex = this.wins.get(id);
    if (ex) {
      ex.title.textContent = title;
      ex.refresh = opts.refresh;
      ex.onClose = opts.onClose;
      ex.body.innerHTML = '';
      this.focus(ex);
      return ex;
    }
    const titleEl = h('span', { class: 'win-title' }, title);
    const closeBtn = h('button', { class: 'win-close', title: 'Close (Esc)' }, '×');
    const header = h('div', { class: 'win-header' }, titleEl, closeBtn);
    const body = h('div', { class: 'win-body' });
    const el = h('div', { class: 'win ' + (opts.cls ?? '') }, header, body);
    el.style.width = (opts.width ?? 340) + 'px';
    const W = window.innerWidth, H = window.innerHeight;
    const x = Math.max(0, Math.min(W - (opts.width ?? 340) - 10, opts.x ?? 70 + (this.cascade % 6) * 28));
    const y = Math.max(50, Math.min(H - 300, opts.y ?? 70 + (this.cascade % 6) * 28));
    this.cascade++;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.root.appendChild(el);
    const win: Win = {
      id, el, body, title: titleEl, refresh: opts.refresh, onClose: opts.onClose,
      close: () => { el.remove(); this.wins.delete(id); win.onClose?.(); },
    };
    closeBtn.addEventListener('click', win.close);
    el.addEventListener('pointerdown', () => this.focus(win));
    // dragging
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = el.offsetLeft, oy = el.offsetTop;
      const move = (ev: PointerEvent) => {
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + ev.clientX - sx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 30, oy + ev.clientY - sy)) + 'px';
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.wins.set(id, win);
    this.focus(win);
    return win;
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
      morphChildren(real, tmp);
    }
  }
}

const REPLACE_TAGS = new Set(['BUTTON', 'A', 'SELECT', 'INPUT', 'CANVAS', 'TEXTAREA']);
const CLICKABLE = /\b(row|model|chip|clickable|link|swatch|slot)\b/;

/** Update `old` to match `nu`, keeping unchanged nodes (and their listeners) in place. */
function morph(old: Node, nu: Node) {
  if (old.nodeType !== nu.nodeType || old.nodeName !== nu.nodeName) { old.parentNode!.replaceChild(nu, old); return; }
  if (old.nodeType === Node.TEXT_NODE) { if (old.nodeValue !== nu.nodeValue) old.nodeValue = nu.nodeValue; return; }
  if (old.nodeType !== Node.ELEMENT_NODE) return;
  const o = old as HTMLElement, n = nu as HTMLElement;
  // interactive elements carry closures: replace them when anything about them changed
  if (REPLACE_TAGS.has(o.tagName) || CLICKABLE.test(o.className)) {
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
