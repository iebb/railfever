// Fast, styled hint tooltips (name + key caps) for elements with data-tip / data-key attributes.
import { h, kbd } from './dom';

export class UiTips {
  private el: HTMLDivElement;
  private target: HTMLElement | null = null;
  private timer = 0;

  constructor(root: HTMLElement) {
    this.el = h('div', { class: 'uitip', role: 'tooltip' });
    root.appendChild(this.el);
    root.addEventListener('pointerover', (e) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (t === this.target) return;
      this.hide();
      if (!t || e.pointerType === 'touch') return;
      this.target = t;
      this.timer = window.setTimeout(() => this.show(t), 300);
    });
    root.addEventListener('pointerout', (e) => {
      const rel = e.relatedTarget as Node | null;
      if (this.target && (!rel || !this.target.contains(rel))) this.hide();
    });
    root.addEventListener('pointerdown', () => this.hide(), true);
    window.addEventListener('blur', () => this.hide());
  }

  private show(t: HTMLElement) {
    if (!t.isConnected || this.target !== t) return;
    const tip = t.dataset.tip ?? '', key = t.dataset.key, sub = t.dataset.sub;
    this.el.replaceChildren(document.createTextNode(tip), ...(sub ? [h('small', null, sub)] : []), ...(key ? key.split(' ').map((k) => kbd(k)) : []));
    const r = t.getBoundingClientRect();
    const w = this.el.offsetWidth, hh = this.el.offsetHeight;
    const W = window.innerWidth;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.top - hh - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(W - w - 6, x));
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    this.el.classList.add('show');
  }

  hide() {
    clearTimeout(this.timer);
    this.target = null;
    this.el.classList.remove('show');
  }
}
