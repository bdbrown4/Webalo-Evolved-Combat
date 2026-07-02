// Vehicle.js — a drivable arcade transport for the finale escape. The player is
// mounted into it; WASD drives (forward/back accelerate along the heading,
// left/right steer, steering scales with speed and flips in reverse). It uses
// the same capsule-vs-AABB Physics as everything else, runs over Coalition
// minions at speed, and drives a third-person chase camera.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';

export class Vehicle {
  constructor(pos, camera) {
    this.camera = camera;
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.heading = 0;          // radians; forward = (sin, 0, cos) to match Player.yaw
    this.radius = 1.4;
    this.height = 1.6;
    this.maxSpeed = 18;
    this.mesh = AssetFactory.vehicle();
    this.mesh.position.copy(this.pos);
    this._spin = 0;
    // IRIS turret: a free-moving on-screen reticle (NDC: x right, y up) that the
    // player nudges with mouse/touch; IRIS auto-fires at the Wobble under it.
    this.aim = { x: 0, y: -0.04 };
    this.fireCd = 0;
    this.lockedTarget = null;
  }

  forward() { return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)); }

  update(dt, input, ctx, gunInput) {
    const throttle = (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0);
    const steer = (input.isDown('left') ? 1 : 0) - (input.isDown('right') ? 1 : 0);

    const fwd = this.forward();
    let fwdSpeed = this.vel.x * fwd.x + this.vel.z * fwd.z; // signed speed along heading

    // steering: scales with speed, and reverses sense when backing up
    const speedFactor = Math.min(1, Math.abs(fwdSpeed) / 6);
    this.heading += steer * 2.4 * dt * speedFactor * (fwdSpeed < -0.1 ? -1 : 1);

    // accelerate / coast / cap (reverse capped slower). Hold Sprint (Shift, or
    // a full-forward push on the mobile stick) to boost top speed + accel.
    this.boosting = input.isDown('sprint');
    const accel = this.boosting ? 40 : 24, drag = 9;
    const topSpeed = this.boosting ? this.maxSpeed * 1.55 : this.maxSpeed;
    if (throttle !== 0) fwdSpeed += throttle * accel * dt;
    else fwdSpeed -= Math.sign(fwdSpeed) * Math.min(Math.abs(fwdSpeed), drag * dt);
    fwdSpeed = Math.max(-this.maxSpeed * 0.4, Math.min(topSpeed, fwdSpeed));

    const nf = this.forward();
    this.vel.x = nf.x * fwdSpeed;
    this.vel.z = nf.z * fwdSpeed;
    this.vel.y += ctx.physics.gravity * dt;

    const res = ctx.physics.moveAndCollide(this.pos, this.vel, dt, this.radius, this.height);
    if (res.grounded && this.vel.y < 0) this.vel.y = 0;

    // splatter minions at speed (the boss is immune to roadkill)
    if (Math.abs(fwdSpeed) > 8 && ctx.enemies) {
      for (const e of ctx.enemies) {
        if (e.dead || e.type === 'boss') continue;
        if (this.pos.distanceTo(e.pos) < this.radius + e.radius + 0.5) {
          e.takeDamage(150, { source: this.pos });
          e.vel.add(nf.clone().setY(0.4).multiplyScalar(12));
        }
      }
    }

    // wheels/visual spin + body bank into turns
    this._spin += fwdSpeed * dt * 2;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;
    this.mesh.rotation.z = -steer * 0.06 * speedFactor;
    if (this.mesh.userData.wheels) for (const w of this.mesh.userData.wheels) w.rotation.x = this._spin;

    // third-person chase camera
    const camPos = this.pos.clone().addScaledVector(nf, -8); camPos.y += 4.5;
    this.camera.position.lerp(camPos, Math.min(1, dt * 6));
    this.camera.lookAt(this.pos.x + nf.x * 5, this.pos.y + 1.4, this.pos.z + nf.z * 5);

    // turret gunner: solo, the driver also guns (gunInput omitted → use the driver
    // input + on-screen reticle); in co-op the guest mans it (gunInput is the guest's
    // networked input, aimed in world space from its reported look).
    this._turret(dt, gunInput || input, ctx, nf, !gunInput);
  }

  // IRIS's turret. Two aim modes feed one firing path:
  //  • reticle (solo): nudge an on-screen reticle, lock the nearest Wobble under it.
  //  • world-aim (co-op gunner): aim along the gunner's reported look direction, lock
  //    the nearest Wobble inside a small angular cone of it.
  // Either way: manual trigger (hold Fire / ADS), hitscan + tracer on a cooldown.
  _turret(dt, input, ctx, nf, reticleMode) {
    let best = null;
    const origin = this.pos.clone().addScaledVector(nf, 0.6); origin.y += 2.0;
    let endPoint;

    if (reticleMode) {
      const SENS = 0.0026; // calmer turret aim
      this.aim.x = Math.max(-0.92, Math.min(0.92, this.aim.x + input.mouseDX * SENS));
      this.aim.y = Math.max(-0.92, Math.min(0.92, this.aim.y - input.mouseDY * SENS));
      this.camera.updateMatrixWorld();
      let bestD = 0.17; // NDC pick radius
      const tmp = new THREE.Vector3();
      if (ctx.enemies) {
        for (const e of ctx.enemies) {
          if (e.dead || e.type === 'boss') continue;      // the boss is roadkill-immune
          tmp.copy(e.aimPoint()).project(this.camera);
          if (tmp.z > 1) continue;                        // behind the camera
          const d = Math.hypot(tmp.x - this.aim.x, tmp.y - this.aim.y);
          if (d < bestD) { bestD = d; best = e; }
        }
      }
      if (!best) {
        const aimW = new THREE.Vector3(this.aim.x, this.aim.y, 0.5).unproject(this.camera);
        const dir = aimW.sub(this.camera.position).normalize();
        endPoint = origin.clone().addScaledVector(dir, 80);
      }
    } else {
      // world-aim from the gunner's look (yaw/pitch reported over the network)
      const pkt = input.latest || {};
      const yaw = pkt.yaw || 0, pitch = pkt.pitch || 0;
      const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      let bestAng = 0.13;                                 // ~7.5° lock cone
      const to = new THREE.Vector3();
      if (ctx.enemies) {
        for (const e of ctx.enemies) {
          if (e.dead || e.type === 'boss') continue;
          to.copy(e.aimPoint()).sub(origin);
          if (to.dot(dir) <= 0) continue;                 // behind the gunner's facing
          const ang = to.normalize().angleTo(dir);
          if (ang < bestAng) { bestAng = ang; best = e; }
        }
      }
      if (!best) endPoint = origin.clone().addScaledVector(dir, 80);
    }
    // occlusion: the turret can't lock or kill through the debris you're meant to
    // slalom around — one ray against the final candidate per frame; a blocked
    // shot sparks on the obstacle instead of passing through it
    if (best && ctx.physics) {
      const to = best.aimPoint().sub(origin);
      const d = to.length();
      to.multiplyScalar(1 / Math.max(1e-6, d));
      const wall = ctx.physics.raycastWorld(origin, to, d);
      if (wall < d - 0.2) { endPoint = origin.clone().addScaledVector(to, wall); best = null; }
    }
    this.lockedTarget = best;

    this.fireCd -= dt;
    const shooting = input.isDown('fire') || input.isDown('ads');
    if (shooting && this.fireCd <= 0) {
      this.fireCd = 0.15;
      const end = best ? best.aimPoint() : endPoint;
      if (best) best.takeDamage(34, { shieldMult: ctx.player ? ctx.player.shieldDmgMult : 1, source: this.pos }); // Goo-Eater perk
      // one hook spawns the tracer, plays the report, marks a hit — and (in co-op)
      // mirrors all three to the gunner, who fires the host's turret remotely.
      if (ctx.onTurretFire) ctx.onTurretFire(origin, end, !!best);
      else { ctx.spawnTracer && ctx.spawnTracer(origin, end); ctx.audio && ctx.audio.sfx('rifle'); if (best) ctx.onHitmark && ctx.onHitmark(); }
    }
  }
}
