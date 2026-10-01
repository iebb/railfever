// RTS-style camera: pan, orbit, zoom-to-cursor, follow.
import * as THREE from 'three';
import type { World } from '../game/world';

export class CameraController {
  target = new THREE.Vector3(32, 0, 32);
  distance = 28;
  yaw = Math.PI * 0.25;
  pitch = 0.85;
  private cur = { tx: 32, ty: 0, tz: 32, d: 28, yaw: Math.PI * 0.25, pitch: 0.85 };
  keys = new Set<string>();
  follow: (() => THREE.Vector3 | null) | null = null;
  private drag: { mode: 'pan' | 'rotate'; x: number; y: number; ground: THREE.Vector3 | null } | null = null;
  minDist = 3;
  maxDist = 150;
  enabled = true;
  /** Whether a single finger drag should pan (set by the UI: only in inspect mode). */
  singleTouchPan: () => boolean = () => true;
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: { d: number; a: number; mx: number; my: number } | null = null;

  constructor(
    public camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    public world: World,
    private pickGround: (cx: number, cy: number) => THREE.Vector3 | null,
  ) {
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.style.touchAction = 'none';
  }

  private touchState() {
    const pts = [...this.touches.values()];
    const [a, b] = pts;
    return { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private panBy(dx: number, dy: number) {
    const s = (this.distance * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const pk = 1 / Math.max(0.35, Math.sin(this.pitch));
    this.target.x -= (rx * dx - fx * dy * pk) * s;
    this.target.z -= (rz * dx - fz * dy * pk) * s;
    this.follow = null;
    this.clampTarget();
  }

  setWorld(w: World) {
    this.world = w;
    this.target.set(w.size / 2, 0, w.size / 2);
    this.cur.tx = this.target.x; this.cur.tz = this.target.z;
  }

  jumpTo(x: number, z: number, dist?: number) {
    this.follow = null;
    this.target.x = x; this.target.z = z;
    if (dist) this.distance = dist;
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    const factor = Math.exp(delta * (e.ctrlKey ? 0.01 : 0.0012));
    const nd = Math.max(this.minDist, Math.min(this.maxDist, this.distance * factor));
    // zoom towards the cursor
    if (!this.follow) {
      const g = this.pickGround(e.clientX, e.clientY);
      if (g) {
        const k = 1 - nd / this.distance;
        this.target.x += (g.x - this.target.x) * k;
        this.target.z += (g.z - this.target.z) * k;
      }
    }
    this.distance = nd;
  };

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) { this.gesture = this.touchState(); this.drag = null; }
      else if (this.touches.size === 1 && this.singleTouchPan()) this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, ground: null };
      return;
    }
    const rotate = e.button === 1 || (e.button === 2 && (e.shiftKey || e.altKey)) || (e.button === 0 && e.altKey);
    const pan = e.button === 2 && !rotate;
    if (!rotate && !pan) return;
    e.preventDefault();
    this.drag = { mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, ground: pan ? this.pickGround(e.clientX, e.clientY) : null };
    if (pan) this.follow = null;
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2 && this.gesture) {
        const g = this.touchState();
        this.distance = Math.max(this.minDist, Math.min(this.maxDist, this.distance * (this.gesture.d / Math.max(1, g.d))));
        this.yaw -= g.a - this.gesture.a;
        this.panBy(g.mx - this.gesture.mx, g.my - this.gesture.my);
        this.gesture = g;
        return;
      }
    }
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    if (this.drag.mode === 'rotate') {
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(0.22, Math.min(1.45, this.pitch + dy * 0.005));
    } else {
      const s = (this.distance * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const pk = 1 / Math.max(0.35, Math.sin(this.pitch));
      this.target.x -= (rx * dx - fx * dy * pk) * s;
      this.target.z -= (rz * dx - fz * dy * pk) * s;
      this.clampTarget();
    }
  };

  private onUp = (e?: PointerEvent) => {
    if (e && e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.gesture = null;
    }
    this.drag = null;
  };

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    this.keys.add(e.key.toLowerCase());
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };

  private clampTarget() {
    const s = this.world.size;
    this.target.x = Math.max(-2, Math.min(s + 2, this.target.x));
    this.target.z = Math.max(-2, Math.min(s + 2, this.target.z));
  }

  update(dt: number) {
    const k = this.keys;
    if (this.enabled) {
      const sp = this.distance * 1.1 * dt;
      let mx = 0, mz = 0;
      if (k.has('w') || k.has('arrowup')) mz -= 1;
      if (k.has('s') || k.has('arrowdown')) mz += 1;
      if (k.has('a') || k.has('arrowleft')) mx -= 1;
      if (k.has('d') || k.has('arrowright')) mx += 1;
      if (mx || mz) {
        this.follow = null;
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        this.target.x += (rx * mx - fx * mz) * sp;
        this.target.z += (rz * mx - fz * mz) * sp;
        this.clampTarget();
      }
      if (k.has('q')) this.yaw += dt * 1.6;
      if (k.has('e')) this.yaw -= dt * 1.6;
      if (k.has('r')) this.pitch = Math.min(1.45, this.pitch + dt);
      if (k.has('f')) this.pitch = Math.max(0.22, this.pitch - dt);
      if (k.has('=') || k.has('+')) this.distance = Math.max(this.minDist, this.distance * (1 - dt * 1.5));
      if (k.has('-')) this.distance = Math.min(this.maxDist, this.distance * (1 + dt * 1.5));
    }
    if (this.follow) {
      const p = this.follow();
      if (p) { this.target.x = p.x; this.target.z = p.z; } else this.follow = null;
    }
    const ground = this.world.heightAt(this.target.x, this.target.z);
    this.target.y = Math.max(ground, 0.05);
    // smoothing
    const a = 1 - Math.exp(-dt * (this.follow ? 8 : 14));
    const c = this.cur;
    c.tx += (this.target.x - c.tx) * a;
    c.ty += (this.target.y - c.ty) * (1 - Math.exp(-dt * 5));
    c.tz += (this.target.z - c.tz) * a;
    c.d += (this.distance - c.d) * a;
    c.yaw += (this.yaw - c.yaw) * a;
    c.pitch += (this.pitch - c.pitch) * a;
    const cp = Math.cos(c.pitch), spt = Math.sin(c.pitch);
    const cam = this.camera;
    cam.position.set(c.tx + Math.sin(c.yaw) * cp * c.d, c.ty + spt * c.d, c.tz + Math.cos(c.yaw) * cp * c.d);
    let minY = this.world.heightAt(cam.position.x, cam.position.z) + 0.4;
    // keep the camera above buildings
    const w = this.world;
    const bx = Math.floor(cam.position.x), bz = Math.floor(cam.position.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!w.inBounds(bx + dx, bz + dz)) continue;
      const b = w.building[w.idx(bx + dx, bz + dz)];
      if (b < 0) continue;
      const bb = w.buildings[b];
      if (bb) minY = Math.max(minY, w.tileMax(bb.x, bb.z) * 0.2 + bb.floors * 0.105 + 0.45);
    }
    if (cam.position.y < minY) cam.position.y = minY;
    cam.lookAt(c.tx, c.ty, c.tz);
  }

  get smoothDistance() { return this.cur.d; }
  get focus() { return new THREE.Vector3(this.cur.tx, this.cur.ty, this.cur.tz); }
}
