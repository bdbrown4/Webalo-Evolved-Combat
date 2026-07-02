// Physics invariants: sliding collision, tunneling protection (substeps), rays,
// and the teleport-destination query.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Physics } from '../src/engine/Physics.js';

function world() {
  const p = new Physics();
  p.addBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 1, z: 40 }, 'floor');   // top at y=0
  p.addBox({ x: 5, y: 3, z: 0 }, { x: 0.4, y: 6, z: 10 }, 'door');      // thin wall at x≈5
  return p;
}

describe('moveAndCollide', () => {
  it('lands on the floor and reports grounded', () => {
    const p = world();
    const pos = new THREE.Vector3(0, 3, 0), vel = new THREE.Vector3(0, 0, 0);
    let grounded = false;
    for (let i = 0; i < 90; i++) {
      vel.y += p.gravity * (1 / 60);            // the game re-applies gravity every frame
      grounded = p.moveAndCollide(pos, vel, 1 / 60, 0.4, 1.7).grounded;
      if (grounded) vel.y = 0;
    }
    expect(pos.y).toBeCloseTo(0, 1);
    expect(grounded).toBe(true);
  });
  it('blocks and slides along a wall', () => {
    const p = world();
    const pos = new THREE.Vector3(4, 0.1, 0), vel = new THREE.Vector3(20, 0, 5);
    for (let i = 0; i < 10; i++) { vel.x = 20; vel.z = 5; p.moveAndCollide(pos, vel, 1 / 60, 0.4, 1.7); }
    expect(pos.x).toBeLessThan(4.5);     // stopped at the wall face (4.8 - radius)
    expect(pos.x).toBeGreaterThan(4.2);  // ...but flush against it, not bounced away
    expect(pos.z).toBeGreaterThan(0.5);  // still slid in z the whole time
  });
  it('does NOT tunnel through a thin door at high speed / low framerate', () => {
    const p = world();
    // 30 u/s at a 50ms hitch frame = 1.5u step — more than the 0.4 door thickness
    const pos = new THREE.Vector3(3.5, 0.1, 0), vel = new THREE.Vector3(30, 0, 0);
    p.moveAndCollide(pos, vel, 0.05, 0.4, 1.7);
    expect(pos.x).toBeLessThan(4.9);
  });
  it('falls through where the safety floor is dropped (escape void)', () => {
    const p = new Physics();
    p.floorY = -300;
    const pos = new THREE.Vector3(0, 1, 0), vel = new THREE.Vector3(0, -50, 0);
    for (let i = 0; i < 40; i++) p.moveAndCollide(pos, vel, 1 / 30, 0.4, 1.7);
    expect(pos.y).toBeLessThan(-10);
  });
});

describe('rays and queries', () => {
  it('raycastWorld reports the wall distance', () => {
    const p = world();
    const d = p.raycastWorld(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 20);
    expect(d).toBeCloseTo(4.8, 1);       // wall face at x = 5 - 0.2
  });
  it('raycastWorldHit reports the surface normal (for grenade bounces)', () => {
    const p = world();
    const h = p.raycastWorldHit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 20);
    expect(h).toBeTruthy();
    expect(h.normal.x).toBe(-1);
  });
  it('hasLineOfSight is blocked by the wall, clear in the open', () => {
    const p = world();
    expect(p.hasLineOfSight(new THREE.Vector3(0, 1, 0), new THREE.Vector3(10, 1, 0))).toBe(false);
    expect(p.hasLineOfSight(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, -10))).toBe(true);
  });
  it('boxFree rejects a spot inside geometry and accepts open ground', () => {
    const p = world();
    expect(p.boxFree(5, 0.1, 0, 0.5, 1.3)).toBe(false);   // inside the door wall
    expect(p.boxFree(-5, 0.1, 0, 0.5, 1.3)).toBe(true);   // open floor
  });
});
