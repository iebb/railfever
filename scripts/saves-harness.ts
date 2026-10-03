// UI integration test adapters: only rendering, audio, fonts, and the unrelated UI shell are replaced.
// Title, save/load windows, HUD, game simulation, storage and the real main.ts remain under test.
import { Hud } from '../src/ui/hud';
import { WindowManager } from '../src/ui/windows';
import { showTitle } from '../src/ui/title';
import { openMenu } from '../src/ui/win-menu';
export const audio: any = {
  settings: { muted: true, master: 1, ui: 1, world: 1, ambient: 1 },
  loadSettings() {}, unlock() {}, setGame() {}, update() {}, saveSettings() {}, play() {},
};
export function loadFonts() { return Promise.resolve(); }
export function cashPitch(_amount: number) { return 1; }
export class Renderer {
  controls: any = { followPosition: null, smoothDistance: 1, focusInto: (v: any) => v, jumpTo() {} };
  camera = {}; night = false; simMs = 0;
  constructor(_app: HTMLElement) {}
  loadSettings() {} setGame(_g: any) {} frame() {}
}
export class UI {
  game: any; root: HTMLElement; hud: Hud; wm: WindowManager; titleOpen = false; following = null;
  tools: any = { setTool() {} };
  constructor(root: HTMLElement, public renderer: Renderer, public app: any) {
    this.root = root; this.wm = new WindowManager(root); this.hud = new Hud(this as any);
  }
  setGame(g: any) { this.game = g; this.wm.closeAll(); this.hud.setGame(g); }
  update() {}
  toast(text: string, kind: string) { (globalThis as any).__notices.push([text, kind]); }
  showTitle(opts: any) { showTitle({ ...opts, ui: this as any }); }
  openNewGame() { this.showTitle({ newGame: true }); }
  openMenu() { openMenu(this as any); }
  sound() {}
}
