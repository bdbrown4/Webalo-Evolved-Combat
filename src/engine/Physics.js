// Physics.js — lightweight collision for an arcade FPS. The world is a set of
// axis-aligned boxes (AABBs). The player and enemies are treated as vertical
// capsules approximated by an AABB of half-width `radius` and total `height`.
// Movement is resolved per-axis so we slide along walls instead of sticking.
//
// BROADPHASE: colliders are binned into a uniform XZ grid (cells of CELL units;
// Y is ignored — levels are laid out in plan). Movement/box queries visit only
// the cells the query AABB overlaps; rays walk their cells with a 2D DDA. Every
// query candidate list is restored to global collider order, so results are
// bit-identical to the brute-force scan (the property test in tests/ asserts
// this). Small scenes skip the grid entirely.

import * as THREE from 'three';

const AXES = ['x', 'y', 'z'];              // static — a fresh array per ray was GC noise
const _losDir = new THREE.Vector3();       // hasLineOfSight scratch (hot: every enemy, every frame)
const CELL = 8;                            // grid cell size (world units)

export class Physics {
  constructor() {
    this.colliders = []; // { min: Vector3, max: Vector3, tag }
    this.gravity = -22;
    // A safety floor that catches anything that falls through the geometry. The
    // open escape track drops this into the void so you can actually fall off.
    this.floorY = 0;
    // grid state — rebuilt lazily after any collider change
    this.gridMin = 32;      // below this many colliders a linear scan is cheaper
    this._grid = null;
    this._dirty = true;
    this._stamp = 0;        // query id for O(1) candidate dedup
    this._cands = [];       // reusable candidate scratch array
  }

  clear() { this.colliders.length = 0; this._dirty = true; }

  addBox(center, size, tag = 'solid') {
    const half = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
    this.colliders.push({
      min: new THREE.Vector3(center.x - half.x, center.y - half.y, center.z - half.z),
      max: new THREE.Vector3(center.x + half.x, center.y + half.y, center.z + half.z),
      tag,
    });
    this._dirty = true;
  }

  // Remove a collider (doors opening). Callers must use this instead of splicing
  // this.colliders directly, or the broadphase grid goes stale.
  removeCollider(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) { this.colliders.splice(i, 1); this._dirty = true; }
  }

  // ---- broadphase internals -------------------------------------------------
  _useGrid() { return this.colliders.length >= this.gridMin; }

  _buildGrid() {
    this._grid = new Map();
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      c._idx = i; c._q = -1;
      const x0 = Math.floor(c.min.x / CELL), x1 = Math.floor(c.max.x / CELL);
      const z0 = Math.floor(c.min.z / CELL), z1 = Math.floor(c.max.z / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const key = gx * 100003 + gz;          // integer key (levels are far under 100k cells wide)
          let arr = this._grid.get(key);
          if (!arr) { arr = []; this._grid.set(key, arr); }
          arr.push(c);
        }
      }
    }
    this._dirty = false;
  }

  // Candidates whose cells overlap [minX..maxX]×[minZ..maxZ], deduped via query
  // stamp and restored to global collider order (so per-axis resolution applies
  // in exactly the order the linear scan would).
  _boxCandidates(minX, maxX, minZ, maxZ) {
    if (this._dirty) this._buildGrid();
    const out = this._cands; out.length = 0;
    const id = ++this._stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const arr = this._grid.get(gx * 100003 + gz);
        if (!arr) continue;
        for (const c of arr) { if (c._q !== id) { c._q = id; out.push(c); } }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._idx - b._idx);
    return out;
  }

  // Walk the XZ cells pierced by a ray (2D DDA), calling fn(cellArray, tEnter)
  // for each occupied cell. fn returns true to stop early (hit closer than any
  // remaining cell). Vertical rays stay in one column, which is correct: cells
  // bin by XZ only, so that column holds everything above and below.
  _walkRayCells(o, d, maxDist, fn) {
    if (this._dirty) this._buildGrid();
    let gx = Math.floor(o.x / CELL), gz = Math.floor(o.z / CELL);
    const stepX = d.x > 0 ? 1 : -1, stepZ = d.z > 0 ? 1 : -1;
    const tDeltaX = d.x !== 0 ? Math.abs(CELL / d.x) : Infinity;
    const tDeltaZ = d.z !== 0 ? Math.abs(CELL / d.z) : Infinity;
    const nextX = d.x > 0 ? (gx + 1) * CELL : gx * CELL;
    const nextZ = d.z > 0 ? (gz + 1) * CELL : gz * CELL;
    let tMaxX = d.x !== 0 ? (nextX - o.x) / d.x : Infinity;
    let tMaxZ = d.z !== 0 ? (nextZ - o.z) / d.z : Infinity;
    let tEnter = 0;
    for (let guard = 0; guard < 4096; guard++) {
      const arr = this._grid.get(gx * 100003 + gz);
      if (arr && fn(arr, tEnter)) return;
      if (tMaxX <= tMaxZ) { tEnter = tMaxX; tMaxX += tDeltaX; gx += stepX; }
      else { tEnter = tMaxZ; tMaxZ += tDeltaZ; gz += stepZ; }
      if (tEnter > maxDist) return;
    }
  }

  // pos is the FEET position. Returns { grounded } and mutates pos + vel.
  // Fast movers (boosted vehicle ~28 u/s, boss charge) are substepped so a frame
  // hitch can't teleport them clean through a thin collider (doors are 0.4 thick).
  moveAndCollide(pos, vel, dt, radius, height) {
    const out = { grounded: false };
    const maxSpeed = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z));
    const steps = Math.min(4, Math.max(1, Math.ceil((maxSpeed * dt) / 0.3)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      // ---- X axis ----
      pos.x += vel.x * sdt;
      this._resolveAxis(pos, vel, radius, height, 'x');
      // ---- Z axis ----
      pos.z += vel.z * sdt;
      this._resolveAxis(pos, vel, radius, height, 'z');
      // ---- Y axis ----
      pos.y += vel.y * sdt;
      if (this._resolveAxis(pos, vel, radius, height, 'y')) out.grounded = true;
    }
    // world floor (default y=0) as a safety net; lowered to a void on the track
    if (pos.y < this.floorY) { pos.y = this.floorY; if (vel.y < 0) vel.y = 0; out.grounded = true; }
    return out;
  }

  // Is an entity-sized box at (x, y, z) clear of all world colliders? Used by
  // teleporting enemies to avoid blinking into geometry.
  boxFree(x, y, z, radius, height) {
    const list = this._useGrid() ? this._boxCandidates(x - radius, x + radius, z - radius, z + radius) : this.colliders;
    for (const c of list) {
      if (x - radius < c.max.x && x + radius > c.min.x &&
          y < c.max.y && y + height > c.min.y &&
          z - radius < c.max.z && z + radius > c.min.z) return false;
    }
    return true;
  }

  // Allocation-free: this runs 3× per substep for every player, enemy, and the
  // vehicle, every frame — the overlap test compares plain numbers against the
  // capsule-AABB implied by (pos, radius, height), never building a box object.
  _resolveAxis(pos, vel, radius, height, axis) {
    let grounded = false;
    const list = this._useGrid() ? this._boxCandidates(pos.x - radius, pos.x + radius, pos.z - radius, pos.z + radius) : this.colliders;
    for (const c of list) {
      if (pos.x - radius >= c.max.x || pos.x + radius <= c.min.x ||
          pos.y >= c.max.y || pos.y + height <= c.min.y ||
          pos.z - radius >= c.max.z || pos.z + radius <= c.min.z) continue;
      // step-up: a low ledge (≤0.45u above the feet) is climbed, not a wall —
      // this is what makes ramps/kerbs/multi-height floors possible at all
      if (axis !== 'y' && c.max.y - pos.y <= 0.45 && c.max.y - pos.y > 0) { pos.y = c.max.y + 0.001; continue; }
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
    }
    return grounded;
  }

  // Raycast against world boxes; returns distance to nearest hit or Infinity.
  raycastWorld(origin, dir, maxDist) {
    let best = maxDist;
    if (!this._useGrid()) {
      for (const c of this.colliders) {
        const t = this._rayBox(origin, dir, c);
        if (t !== null && t < best) best = t;
      }
      return best;
    }
    const id = ++this._stamp;
    this._walkRayCells(origin, dir, maxDist, (arr, tEnter) => {
      if (tEnter > best) return true;                    // every later cell is farther than the hit
      for (const c of arr) {
        if (c._q === id) continue;
        c._q = id;
        const t = this._rayBox(origin, dir, c);
        if (t !== null && t < best) best = t;
      }
      return false;
    });
    return best;
  }

  // Like raycastWorld, but also reports the surface normal of the nearest hit
  // (grenades need it to bounce). Returns { dist, normal } or null.
  raycastWorldHit(origin, dir, maxDist) {
    let best = null;
    if (!this._useGrid()) {
      for (const c of this.colliders) {
        const h = this._rayBoxHit(origin, dir, c);
        if (h && h.dist < (best ? best.dist : maxDist)) best = h;
      }
      return best;
    }
    const id = ++this._stamp;
    this._walkRayCells(origin, dir, maxDist, (arr, tEnter) => {
      if (best && tEnter > best.dist) return true;
      for (const c of arr) {
        if (c._q === id) continue;
        c._q = id;
        const h = this._rayBoxHit(origin, dir, c);
        if (h && h.dist < (best ? best.dist : maxDist)) best = h;
      }
      return false;
    });
    return best;
  }

  _rayBoxHit(o, d, box) {
    let tmin = 0, tmax = Infinity, axis = null;
    for (const ax of AXES) {
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
    for (const ax of AXES) {
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
    const dir = _losDir.subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.001) return true;
    dir.multiplyScalar(1 / dist);
    return this.raycastWorld(from, dir, dist) >= dist - 0.2;
  }
}
