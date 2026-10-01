// Tiny DOM helpers.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement) { while (el.firstChild) el.removeChild(el.firstChild); }

export function fmtInt(n: number) { return Math.round(n).toLocaleString('en-US'); }

/** Escape text for innerHTML. */
export function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }

export function bar(frac: number, color?: string): HTMLElement {
  const f = Math.max(0, Math.min(1, frac));
  const col = color ?? (f > 0.66 ? '#4cd964' : f > 0.4 ? '#ffcc00' : '#ff5e3a');
  return h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${(f * 100).toFixed(0)}%;background:${col}` }));
}

/** Small inline SVG icons for the toolbar. */
export const ICONS: Record<string, string> = {
  inspect: '<path d="M5 3l12 6-5 2 4 7-2 1-4-7-4 4z" fill="currentColor"/>',
  rail: '<path d="M7 2v20M17 2v20M4 5h16M4 9h16M4 13h16M4 17h16M4 21h16" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  road: '<path d="M8 2L5 22M16 2l3 20" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 3v3M12 10v4M12 18v3" stroke="currentColor" stroke-width="2"/>',
  station: '<path d="M3 10l9-6 9 6v2H3z M5 13h2v7H5zM11 13h2v7h-2zM17 13h2v7h-2zM3 20h18v2H3z" fill="currentColor"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="3" fill="currentColor"/><rect x="6" y="6" width="12" height="5" fill="#1b2430"/><circle cx="8" cy="20" r="2" fill="currentColor"/><circle cx="16" cy="20" r="2" fill="currentColor"/>',
  depot: '<path d="M2 11l10-7 10 7v11h-5v-7H7v7H2z" fill="currentColor"/>',
  garage: '<path d="M3 9l9-5 9 5v13H3z" fill="currentColor"/><path d="M6 13h12M6 16h12M6 19h12" stroke="#1b2430" stroke-width="1.6"/>',
  signal: '<rect x="8" y="2" width="8" height="13" rx="2" fill="currentColor"/><circle cx="12" cy="6" r="2" fill="#ff5e3a"/><circle cx="12" cy="11" r="2" fill="#4cd964"/><path d="M12 15v7" stroke="currentColor" stroke-width="2"/>',
  bulldoze: '<path d="M3 15h11l3-6h3v6h1v4H3z" fill="currentColor"/><circle cx="7" cy="19" r="2" fill="#1b2430"/><circle cx="15" cy="19" r="2" fill="#1b2430"/><path d="M2 8l6-4 1 2-5 4z" fill="currentColor"/>',
  terraform: '<path d="M2 20l6-9 4 5 3-4 7 8z" fill="currentColor"/><path d="M12 2v6M9 5l3-3 3 3" stroke="currentColor" stroke-width="2" fill="none"/>',
  lines: '<circle cx="5" cy="6" r="2.5" fill="currentColor"/><circle cx="19" cy="18" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M5 6l7 6 7 6" stroke="currentColor" stroke-width="2" fill="none"/>',
  vehicles: '<rect x="2" y="7" width="20" height="10" rx="2" fill="currentColor"/><rect x="4" y="9" width="4" height="3" fill="#1b2430"/><rect x="10" y="9" width="4" height="3" fill="#1b2430"/><rect x="16" y="9" width="4" height="3" fill="#1b2430"/><circle cx="7" cy="19" r="2" fill="currentColor"/><circle cx="17" cy="19" r="2" fill="currentColor"/>',
  money: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 8.5c-.8-1-2-1.5-3.2-1.5-1.8 0-3.3 1-3.3 2.5 0 3.5 6.8 1.8 6.8 5 0 1.6-1.6 2.5-3.5 2.5-1.4 0-2.7-.6-3.5-1.7M12 5v14" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  towns: '<path d="M2 22V12l5-4 5 4v10zM13 22V6l4-4 5 4v16z" fill="currentColor"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2.4"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  ff: '<path d="M3 5l9 7-9 7zM12 5l9 7-9 7z" fill="currentColor"/>',
  news: '<path d="M4 4h13v16H6a2 2 0 01-2-2zM17 8h3v10a2 2 0 01-2 2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 8h7M7 12h7M7 16h5" stroke="currentColor" stroke-width="1.8"/>',
  company: '<path d="M4 21V9l6-4v4l6-4v16z" fill="currentColor"/><path d="M18 21V3h3v18z" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9a3 3 0 115 2c-1 .7-2 1.3-2 3M12 17v1" stroke="currentColor" stroke-width="2" fill="none"/>',
};

export function icon(name: string, size = 22): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.innerHTML = ICONS[name] ?? '';
  return s;
}
