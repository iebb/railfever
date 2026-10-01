// Build previews, hover highlights and markers.
import * as THREE from 'three';
import { World } from '../game/world';
import { HSTEP, DX, DZ, EDGE_MID_X, EDGE_MID_Z, OPP } from '../game/constants';
import type { RoutePlan } from '../game/construction';

function tileQuads(w: World, tiles: [number, number][], lift: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const c = [0, 0, 0, 0];
  for (const [x, z] of tiles) {
    if (!w.inBounds(x, z)) continue;
    w.corners(x, z, c);
    const y = (i: number) => c[i] * HSTEP + lift;
    const p = [[x, y(0), z], [x + 1, y(1), z], [x + 1, y(2), z + 1], [x, y(3), z + 1]];
    const tri = (a: number, b: number, d: number) => pos.push(...p[a], ...p[b], ...p[d]);
    if (!World.splitOf(c)) { tri(0, 2, 1); tri(0, 3, 2); } else { tri(0, 3, 1); tri(1, 3, 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export class Overlay {
  group = new THREE.Group();
  private hover: THREE.Mesh;
  private area: THREE.Mesh;
  private ghost: THREE.Mesh;
  private marker: THREE.Mesh;
  private arrow: THREE.Mesh;
  private hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  private areaMat = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  private ghostMat = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });

  constructor(public world: World) {
    this.hover = new THREE.Mesh(new THREE.BufferGeometry(), this.hoverMat);
    this.area = new THREE.Mesh(new THREE.BufferGeometry(), this.areaMat);
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffee55, depthTest: false, transparent: true, opacity: 0.9 }));
    const ag = new THREE.ConeGeometry(0.12, 0.3, 8);
    ag.rotateX(Math.PI / 2);
    this.arrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: 0xffee55, transparent: true, opacity: 0.85 }));
    for (const m of [this.hover, this.area, this.ghost, this.marker, this.arrow]) { m.visible = false; m.renderOrder = 10; m.frustumCulled = false; this.group.add(m); }
  }

  setWorld(w: World) { this.world = w; this.clear(); }

  private linePaths = new Map<number, THREE.Mesh>();
  /** Show a coloured route ribbon for a line (pieces of curves), or remove it with null. */
  setLinePath(id: number, pieces: { curve: { pts: Float32Array }; rev: boolean }[] | null, color = '#ffffff', lift = 0.16) {
    const old = this.linePaths.get(id);
    if (old) { this.group.remove(old); old.geometry.dispose(); (old.material as THREE.Material).dispose(); this.linePaths.delete(id); }
    if (!pieces || !pieces.length) return;
    const pos: number[] = [];
    const half = 0.07;
    for (const p of pieces) {
      const pts = p.curve.pts;
      const n = pts.length / 3;
      for (let i = 0; i < n - 1; i++) {
        const ax = pts[i * 3], ay = pts[i * 3 + 1] + lift, az = pts[i * 3 + 2];
        const bx = pts[i * 3 + 3], by = pts[i * 3 + 4] + lift, bz = pts[i * 3 + 5];
        let tx = bx - ax, tz = bz - az;
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const rx = -tz * half, rz = tx * half;
        pos.push(ax - rx, ay, az - rz, bx - rx, by, bz - rz, bx + rx, by, bz + rz);
        pos.push(ax - rx, ay, az - rz, bx + rx, by, bz + rz, ax + rx, ay, az + rz);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 9;
    this.group.add(m);
    this.linePaths.set(id, m);
  }
  linePathIds() { return [...this.linePaths.keys()]; }

  clear() {
    for (const m of [this.hover, this.area, this.ghost, this.marker, this.arrow]) m.visible = false;
  }

  setHover(x: number, z: number, color = 0xffffff) {
    this.hover.geometry.dispose();
    this.hover.geometry = tileQuads(this.world, [[x, z]], 0.04);
    this.hoverMat.color.setHex(color);
    this.hover.visible = true;
  }
  hideHover() { this.hover.visible = false; }

  setArea(tiles: [number, number][], color: number, opacity = 0.3) {
    this.area.geometry.dispose();
    this.area.geometry = tileQuads(this.world, tiles.slice(0, 4000), 0.05);
    this.areaMat.color.setHex(color);
    this.areaMat.opacity = opacity;
    this.area.visible = tiles.length > 0;
  }
  hideArea() { this.area.visible = false; }

  setMarker(x: number, y: number, z: number) { this.marker.position.set(x, y, z); this.marker.visible = true; }
  hideMarker() { this.marker.visible = false; }

  setArrow(x: number, z: number, dir: number) {
    const y = this.world.heightAt(x + 0.5, z + 0.5) + 0.35;
    this.arrow.position.set(x + 0.5 + DX[dir] * 0.25, y, z + 0.5 + DZ[dir] * 0.25);
    this.arrow.lookAt(x + 0.5 + DX[dir] * 2, y, z + 0.5 + DZ[dir] * 2);
    this.arrow.visible = true;
  }
  hideArrow() { this.arrow.visible = false; }

  setPlan(plan: RoutePlan | null) {
    if (!plan || !plan.steps.length) { this.ghost.visible = false; return; }
    const pos: number[] = [];
    const strip = (pts: number[][], half: number) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay, az] = pts[i], [bx, by, bz] = pts[i + 1];
        let tx = bx - ax, tz = bz - az;
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const rx = -tz * half, rz = tx * half;
        pos.push(ax - rx, ay, az - rz, bx - rx, by, bz - rz, bx + rx, by, bz + rz);
        pos.push(ax - rx, ay, az - rz, bx + rx, by, bz + rz, ax + rx, ay, az + rz);
      }
    };
    const lift = 0.12;
    const half = plan.kind === 'rail' ? 0.13 : 0.2;
    for (const s of plan.steps) {
      const cx = s.x + 0.5, cz = s.z + 0.5;
      const pts: number[][] = [];
      const A = s.a >= 0 ? [s.x + EDGE_MID_X[s.a], s.hIn * HSTEP + lift, s.z + EDGE_MID_Z[s.a]] : [cx, s.hOut * HSTEP + lift, cz];
      const B = s.b >= 0 ? [s.x + EDGE_MID_X[s.b], s.hOut * HSTEP + lift, s.z + EDGE_MID_Z[s.b]] : [cx, s.hIn * HSTEP + lift, cz];
      const C = [cx, (A[1] + B[1]) / 2, cz];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, u = 1 - t;
        pts.push([u * u * A[0] + 2 * u * t * C[0] + t * t * B[0], A[1] + (B[1] - A[1]) * t, u * u * A[2] + 2 * u * t * C[2] + t * t * B[2]]);
      }
      strip(pts, half);
      if (s.link) {
        const ex = s.x + EDGE_MID_X[s.b], ez = s.z + EDGE_MID_Z[s.b];
        const n = s.link.span;
        const lx = s.x + DX[s.b] * (n + 1) + EDGE_MID_X[OPP[s.b]], lz = s.z + DZ[s.b] * (n + 1) + EDGE_MID_Z[OPP[s.b]];
        const y = s.hOut * HSTEP + lift + (s.link.kind === 'bridge' ? 0.02 : 0.5);
        strip([[ex, y, ez], [lx, y, lz]], half * (s.link.kind === 'bridge' ? 1.3 : 0.7));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.ghost.geometry.dispose();
    this.ghost.geometry = g;
    this.ghostMat.color.setHex(plan.ok ? 0x44ff88 : 0xff4444);
    this.ghost.visible = true;
  }
}
