// Broadphase property test: the grid path must be BIT-IDENTICAL to the brute-
// force scan for every query type, on randomized worlds. If the DDA misses a
// cell or dedup breaks ordering, this is what catches it.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Physics } from '../src/engine/Physics.js';

// deterministic LCG so failures reproduce
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function randomWorld(r, n) {
  const grid = new Physics(); grid.gridMin = 0;          // force the grid path
  const brute = new Physics(); brute.gridMin = Infinity; // force the linear path
  for (let i = 0; i < n; i++) {
    const c = { x: (r() - 0.5) * 90, y: r() * 6, z: (r() - 0.5) * 90 };
    const s = { x: 0.4 + r() * 9, y: 0.5 + r() * 5, z: 0.4 + r() * 9 };
    grid.addBox(c, s); brute.addBox(c, s);
  }
  return { grid, brute };
}

describe('broadphase ≡ brute force', () => {
  it('raycastWorld matches on 300 random rays', () => {
    const r = rng(1234);
    const { grid, brute } = randomWorld(r, 80);
    for (let i = 0; i < 300; i++) {
      const o = new THREE.Vector3((r() - 0.5) * 100, r() * 6, (r() - 0.5) * 100);
      const d = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.4, r() - 0.5).normalize();
      const maxD = 5 + r() * 90;
      expect(grid.raycastWorld(o, d, maxD)).toBe(brute.raycastWorld(o, d, maxD));
    }
  });
  it('raycastWorldHit matches (distance + normal)', () => {
    const r = rng(77);
    const { grid, brute } = randomWorld(r, 60);
    for (let i = 0; i < 200; i++) {
      const o = new THREE.Vector3((r() - 0.5) * 100, r() * 6, (r() - 0.5) * 100);
      const d = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.4, r() - 0.5).normalize();
      const a = grid.raycastWorldHit(o, d, 80), b = brute.raycastWorldHit(o, d, 80);
      if (!a || !b) expect(a).toEqual(b);
      else { expect(a.dist).toBe(b.dist); expect(a.normal.equals(b.normal)).toBe(true); }
    }
  });
  it('vertical rays stay correct (single-column walk)', () => {
    const r = rng(9);
    const { grid, brute } = randomWorld(r, 60);
    for (let i = 0; i < 100; i++) {
      const o = new THREE.Vector3((r() - 0.5) * 80, 20, (r() - 0.5) * 80);
      const d = new THREE.Vector3(0, -1, 0);
      expect(grid.raycastWorld(o, d, 40)).toBe(brute.raycastWorld(o, d, 40));
    }
  });
  it('boxFree matches on 400 random probes', () => {
    const r = rng(42);
    const { grid, brute } = randomWorld(r, 80);
    for (let i = 0; i < 400; i++) {
      const x = (r() - 0.5) * 100, y = r() * 6, z = (r() - 0.5) * 100;
      expect(grid.boxFree(x, y, z, 0.55, 1.3)).toBe(brute.boxFree(x, y, z, 0.55, 1.3));
    }
  });
  it('moveAndCollide produces identical trajectories', () => {
    const r = rng(2026);
    const { grid, brute } = randomWorld(r, 80);
    for (let run = 0; run < 20; run++) {
      const start = { x: (r() - 0.5) * 80, y: 4 + r() * 4, z: (r() - 0.5) * 80 };
      const pa = new THREE.Vector3(start.x, start.y, start.z), va = new THREE.Vector3((r() - 0.5) * 20, 0, (r() - 0.5) * 20);
      const pb = pa.clone(), vb = va.clone();
      for (let step = 0; step < 90; step++) {
        va.y += grid.gravity * (1 / 60); vb.y += brute.gravity * (1 / 60);
        const ga = grid.moveAndCollide(pa, va, 1 / 60, 0.4, 1.7);
        const gb = brute.moveAndCollide(pb, vb, 1 / 60, 0.4, 1.7);
        expect(ga.grounded).toBe(gb.grounded);
        if (ga.grounded) { va.y = 0; vb.y = 0; }
      }
      expect(pa.x).toBe(pb.x); expect(pa.y).toBe(pb.y); expect(pa.z).toBe(pb.z);
    }
  });
  it('removeCollider invalidates the grid (doors open for both paths)', () => {
    const grid = new Physics(); grid.gridMin = 0;
    grid.addBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 1, z: 40 }, 'floor');
    grid.addBox({ x: 5, y: 3, z: 0 }, { x: 0.4, y: 6, z: 10 }, 'door');
    const door = grid.colliders[1];
    const o = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(1, 0, 0);
    expect(grid.raycastWorld(o, d, 20)).toBeCloseTo(4.8, 3);
    grid.removeCollider(door);
    expect(grid.raycastWorld(o, d, 20)).toBe(20);
  });
});
