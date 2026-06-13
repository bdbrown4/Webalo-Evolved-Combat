// Physics.js — lightweight collision for an arcade FPS. The world is a set of
// axis-aligned boxes (AABBs). The player and enemies are treated as vertical
// capsules approximated by an AABB of half-width `radius` and total `height`.
// Movement is resolved per-axis so we slide along walls instead of sticking.

import * as THREE from 'three';

export class Physics {
  constructor() {
    this.colliders = []; // { min: Vector3, max: Vector3, tag }
    this.gravity = -22;
    // A safety floor that catches anything that falls through the geometry. The
    // open escape track drops this into the void so you can actually fall off.
    this.floorY = 0;
  }

  clear() { this.colliders.length = 0; }

  addBox(center, size, tag = 'solid') {
    const half = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
    this.colliders.push({
      min: new THREE.Vector3(center.x - half.x, center.y - half.y, center.z - half.z),
      max: new THREE.Vector3(center.x + half.x, center.y + half.y, center.z + half.z),
      tag,
    });
  }

  // pos is the FEET position. Returns { grounded } and mutates pos + vel.
  moveAndCollide(pos, vel, dt, radius, height) {
    const out = { grounded: false };
    // ---- X axis ----
    pos.x += vel.x * dt;
    this._resolveAxis(pos, vel, radius, height, 'x');
    // ---- Z axis ----
    pos.z += vel.z * dt;
    this._resolveAxis(pos, vel, radius, height, 'z');
    // ---- Y axis ----
    pos.y += vel.y * dt;
    out.grounded = this._resolveAxis(pos, vel, radius, height, 'y');
    // world floor (default y=0) as a safety net; lowered to a void on the track
    if (pos.y < this.floorY) { pos.y = this.floorY; if (vel.y < 0) vel.y = 0; out.grounded = true; }
    return out;
  }

  _playerAABB(pos, radius, height) {
    return {
      min: new THREE.Vector3(pos.x - radius, pos.y, pos.z - radius),
      max: new THREE.Vector3(pos.x + radius, pos.y + height, pos.z + radius),
    };
  }

  _overlap(a, b) {
    return a.min.x < b.max.x && a.max.x > b.min.x &&
           a.min.y < b.max.y && a.max.y > b.min.y &&
           a.min.z < b.max.z && a.max.z > b.min.z;
  }

  _resolveAxis(pos, vel, radius, height, axis) {
    let grounded = false;
    const box = this._playerAABB(pos, radius, height);
    for (const c of this.colliders) {
      if (!this._overlap(box, c)) continue;
      if (axis === 'x') {
        if (vel.x > 0) pos.x = c.min.x - radius - 0.001;
        else if (vel.x < 0) pos.x = c.max.x + radius + 0.001;
        vel.x = 0;
      } else if (axis === 'z') {
        if (vel.z > 0) pos.z = c.min.z - radius - 0.001;
        else if (vel.z < 0) pos.z = c.max.z + radius + 0.001;
        vel.z = 0;
      } else {
        if (vel.y <= 0) { pos.y = c.max.y + 0.001; grounded = true; }
        else { pos.y = c.min.y - height - 0.001; }
        vel.y = 0;
      }
      box.min.copy(this._playerAABB(pos, radius, height).min);
      box.max.copy(this._playerAABB(pos, radius, height).max);
    }
    return grounded;
  }

  // Raycast against world boxes; returns distance to nearest hit or Infinity.
  raycastWorld(origin, dir, maxDist) {
    let best = maxDist;
    for (const c of this.colliders) {
      const t = this._rayBox(origin, dir, c);
      if (t !== null && t < best) best = t;
    }
    return best;
  }

  // Like raycastWorld, but also reports the surface normal of the nearest hit
  // (grenades need it to bounce). Returns { dist, normal } or null.
  raycastWorldHit(origin, dir, maxDist) {
    let best = null;
    for (const c of this.colliders) {
      const h = this._rayBoxHit(origin, dir, c);
      if (h && h.dist < (best ? best.dist : maxDist)) best = h;
    }
    return best;
  }

  _rayBoxHit(o, d, box) {
    let tmin = 0, tmax = Infinity, axis = null;
    for (const ax of ['x', 'y', 'z']) {
      const inv = 1 / (d[ax] || 1e-9);
      let t1 = (box.min[ax] - o[ax]) * inv;
      let t2 = (box.max[ax] - o[ax]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; axis = ax; }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    if (axis === null) return null; // origin inside the box: no useful normal
    const normal = new THREE.Vector3();
    normal[axis] = d[axis] > 0 ? -1 : 1;
    return { dist: tmin, normal };
  }

  _rayBox(o, d, box) {
    let tmin = 0, tmax = Infinity;
    for (const ax of ['x', 'y', 'z']) {
      const inv = 1 / (d[ax] || 1e-9);
      let t1 = (box.min[ax] - o[ax]) * inv;
      let t2 = (box.max[ax] - o[ax]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    return tmin >= 0 ? tmin : null;
  }

  // Is there clear line of sight between two points (ignores entities)?
  hasLineOfSight(from, to) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.001) return true;
    dir.normalize();
    return this.raycastWorld(from, dir, dist) >= dist - 0.2;
  }
}
