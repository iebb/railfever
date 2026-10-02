// RTS-style camera: pan, orbit, zoom-to-cursor, follow. 1 unit = 10 m.
import * as THREE from 'three';
import { World, pointInRect } from '../game/world';
import { WATER_Y } from '../game/constants';
import { FLOOR_H } from '../game/towns';

export class CameraController {
  target = new THREE.Vector3(128, 0, 128);
  distance = 60;
  yaw = Math.PI * 0.25;
  pitch = 0.8;
  private cur = { tx: 128, ty: 0, tz: 128, d: 60, yaw: Math.PI * 0.25, pitch: 0.8 };
  keys = new Set<string>();
  follow: (() => THREE.Vector3 | null) | null = null;
  private drag: { mode: 'pan' | 'rotate'; x: number; y: number } | null = null;
  minDist = 1.5;
  maxDist = 700;
  minPitch = 0.1;
  maxPitch = 1.5;
  enabled = true;
  /** Whether a single finger drag should pan (set by the UI: only in inspect mode). */
  singleTouchPan: () => boolean = () => true;
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: { d: number; a: number; mx: number; my: number } | null = null;

  constructor(
    public camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    public world: World | null,
    private pickGround: (cx: number, cy: number) => THREE.Vector3 | null,
  ) {
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.style.touchAction = 'none';
  }

  private touchState() {
    const [a, b] = [...this.touches.values()];
    return { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  /** Pan by a screen-space delta (pixels). */
  private panBy(dx: number, dy: number) {
    const s = (this.distance * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.dom.clientHeight);
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
    // far enough to frame the whole map (1536 units on XL maps)
    this.maxDist = Math.max(250, Math.min(1800, w.size * 1.1));
    this.follow = null;
    this.target.set(w.size / 2, 0, w.size / 2);
    this.distance = Math.min(this.maxDist, 90);
    const c = this.cur;
    c.tx = this.target.x; c.tz = this.target.z; c.ty = Math.max(w.heightAt(c.tx, c.tz), WATER_Y);
    c.d = this.distance;
  }

  jumpTo(x: number, z: number, dist?: number) {
    this.follow = null;
    this.target.x = x; this.target.z = z;
    if (dist) this.distance = Math.max(this.minDist, Math.min(this.maxDist, dist));
    this.clampTarget();
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
    const factor = Math.exp(Math.max(-1, Math.min(1, delta * (e.ctrlKey ? 0.01 : 0.0014))));
    const nd = Math.max(this.minDist, Math.min(this.maxDist, this.distance * factor));
    // zoom towards the cursor
    if (!this.follow) {
      const g = this.pickGround(e.clientX, e.clientY);
      if (g) {
        const k = 1 - nd / this.distance;
        this.target.x += (g.x - this.target.x) * k;
        this.target.z += (g.z - this.target.z) * k;
        this.clampTarget();
      }
    }
    this.distance = nd;
  };

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) { this.gesture = this.touchState(); this.drag = null; }
      else if (this.touches.size === 1 && this.singleTouchPan()) this.drag = { mode: 'pan', x: e.clientX, y: e.clientY };
      return;
    }
    const rotate = e.button === 1 || (e.button === 2 && (e.shiftKey || e.altKey)) || (e.button === 0 && e.altKey);
    const pan = e.button === 2 && !rotate;
    if (!rotate && !pan) return;
    e.preventDefault();
    this.drag = { mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY };
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
      this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch + dy * 0.005));
    } else this.panBy(dx, dy);
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
    if (e.ctrlKey || e.metaKey) return;
    this.keys.add(e.key.toLowerCase());
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };

  private clampTarget() {
    const s = this.world ? this.world.size : 1e6;
    this.target.x = Math.max(0, Math.min(s, this.target.x));
    this.target.z = Math.max(0, Math.min(s, this.target.z));
  }

  /** Visible ground (terrain or water surface) height. */
  private ground(x: number, z: number) {
    const w = this.world!;
    return Math.max(w.heightAt(x, z), WATER_Y);
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
      if (k.has('r')) this.pitch = Math.min(this.maxPitch, this.pitch + dt);
      if (k.has('f')) this.pitch = Math.max(this.minPitch, this.pitch - dt);
      if (k.has('=') || k.has('+')) this.distance = Math.max(this.minDist, this.distance * (1 - dt * 1.5));
      if (k.has('-')) this.distance = Math.min(this.maxDist, this.distance * (1 + dt * 1.5));
    }
    const cam = this.camera;
    if (!this.world) { cam.position.set(this.target.x, 50, this.target.z + 50); cam.lookAt(this.target); return; }
    if (this.follow) {
      const p = this.follow();
      if (p) { this.target.x = p.x; this.target.z = p.z; this.clampTarget(); } else this.follow = null;
    }
    this.target.y = this.ground(this.target.x, this.target.z);
    // smoothing
    const a = 1 - Math.exp(-dt * (this.follow ? 8 : 14));
    const c = this.cur;
    c.tx += (this.target.x - c.tx) * a;
    c.ty += (this.target.y - c.ty) * (1 - Math.exp(-dt * 6));
    c.tz += (this.target.z - c.tz) * a;
    c.d += (this.distance - c.d) * a;
    c.yaw += (this.yaw - c.yaw) * a;
    c.pitch += (this.pitch - c.pitch) * a;
    const cp = Math.cos(c.pitch), spt = Math.sin(c.pitch);
    cam.position.set(c.tx + Math.sin(c.yaw) * cp * c.d, c.ty + spt * c.d, c.tz + Math.cos(c.yaw) * cp * c.d);
    // keep the camera above the ground and buildings
    const clear = 0.08 + c.d * 0.02;
    let minY = this.ground(cam.position.x, cam.position.z) + clear;
    if (cam.position.y - minY < 12) for (const b of this.world.buildingsNear(cam.position.x, cam.position.z, 3)) {
      if (!pointInRect(cam.position.x, cam.position.z, b.x, b.z, b.angle, b.w / 2 + 0.2, b.d / 2 + 0.2)) continue;
      minY = Math.max(minY, b.y + b.floors * FLOOR_H + 0.35 + Math.min(b.w, b.d) * 0.35 + 0.15);
    }
    // keep the line of sight to the focus above the terrain
    for (let i = 1; i <= 8; i++) {
      const f = i / 9;
      const x = c.tx + (cam.position.x - c.tx) * f, z = c.tz + (cam.position.z - c.tz) * f;
      const need = this.ground(x, z) + clear * f;
      const y = c.ty + (cam.position.y - c.ty) * f;
      if (y < need) minY = Math.max(minY, c.ty + (need - c.ty) / f);
    }
    if (cam.position.y < minY) cam.position.y = minY;
    cam.lookAt(c.tx, c.ty, c.tz);
  }

  get smoothDistance() { return this.cur.d; }
  get focus() { return new THREE.Vector3(this.cur.tx, this.cur.ty, this.cur.tz); }
  /** Smoothed focus point written into `out` (no allocation). */
  focusInto(out: THREE.Vector3) { return out.set(this.cur.tx, this.cur.ty, this.cur.tz); }
}
