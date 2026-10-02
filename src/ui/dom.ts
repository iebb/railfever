// Tiny DOM helpers and small reusable components of the design system.
import { icon } from './icons';

export { icon, svg } from './icons';

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
      // Window refresh compares markup: selected must be reflected there as well as in the live option.
      else if (k === 'selected') { (el as HTMLOptionElement).selected = !!v; el.toggleAttribute('selected', !!v); }
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

/** Append children, skipping null / false (like h()). */
export function add(el: Node, ...children: Child[]) { append(el, children); }

export function fmtInt(n: number) { return Math.round(n).toLocaleString('en-US'); }

/** Escape text for innerHTML. */
export function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }

/** Progress bar; colour follows the value unless given. */
export function bar(frac: number, color?: string): HTMLElement {
  const f = Math.max(0, Math.min(1, frac));
  const col = color ?? (f > 0.66 ? 'var(--pos)' : f > 0.4 ? 'var(--warn)' : 'var(--neg)');
  return h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${(f * 100).toFixed(0)}%;background:${col}` }));
}

/** Stat tile: big condensed number with a caption. */
export function tile(value: Node | string, caption: string, tone = '', extra?: Node | string | null): HTMLElement {
  return h('div', { class: 'tile' + (tone ? ' ' + tone : '') }, h('div', { class: 'tile-v' }, value), h('div', { class: 'tile-k' }, caption), extra ?? null);
}

/** Keyboard key cap. */
export function kbd(k: string): HTMLElement { return h('kbd', null, k); }

/** Section header (condensed caps) with optional content on the right. */
export function section(title: string, right?: Node | string | null): HTMLElement {
  return h('div', { class: 'section' }, h('span', null, title), right ? h('span', { class: 'section-r' }, right) : null);
}

/** Icon button. */
export function iconBtn(name: string, title: string, onclick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: 'ibtn ' + cls, title, 'aria-label': title, onclick }, icon(name, 18));
}

/** Segmented control. */
export function seg<V extends string | number>(opts: [V, string, string?][], value: V, onPick: (v: V) => void, cls = ''): HTMLElement {
  return h('div', { class: 'seg ' + cls, role: 'radiogroup' }, opts.map(([v, label, tip]) =>
    h('button', { class: 'segb' + (v === value ? ' on' : ''), title: tip ?? '', role: 'radio', 'aria-checked': v === value ? 'true' : 'false', onclick: () => onPick(v) }, label)));
}

/** − value + stepper. */
export function stepper(value: string, dec: () => void, inc: () => void, tip = ''): HTMLElement {
  return h('div', { class: 'stepper', title: tip },
    h('button', { class: 'stp', 'aria-label': 'Decrease', onclick: dec }, icon('minus', 14)),
    h('span', { class: 'stp-v' }, value),
    h('button', { class: 'stp', 'aria-label': 'Increase', onclick: inc }, icon('plus', 14)));
}

/** Labelled form/option row. */
export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'field' }, h('label', { class: 'field-l' }, label), h('div', { class: 'field-c' }, control), hint ? h('div', { class: 'field-h' }, hint) : null);
}

/** Checkbox styled as a switch. */
export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string, disabled = false): HTMLElement {
  const c = h('input', { type: 'checkbox', checked, class: 'sw-in', disabled }) as HTMLInputElement;
  if (checked) c.setAttribute('checked', '');
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'switch' }, c, h('span', { class: 'sw' }), h('span', { class: 'sw-l' }, label, hint ? h('small', null, hint) : null));
}
