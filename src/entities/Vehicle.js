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

  update(dt, input, ctx) {
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

    this._turret(dt, input, ctx, nf);
  }

  // IRIS's turret: move the reticle with look input, lock onto the nearest Wobble
  // under it (in screen space), and auto-fire on a cooldown. Hitscan + tracer.
  _turret(dt, input, ctx, nf) {
    const SENS = 0.0026; // calmer turret aim
    this.aim.x = Math.max(-0.92, Math.min(0.92, this.aim.x + input.mouseDX * SENS));
    this.aim.y = Math.max(-0.92, Math.min(0.92, this.aim.y - input.mouseDY * SENS));

    this.camera.updateMatrixWorld();
    let best = null, bestD = 0.17; // NDC pick radius
    const tmp = new THREE.Vector3();
    if (ctx.enemies) {
      for (const e of ctx.enemies) {
        if (e.dead || e.type === 'boss') continue;        // the boss is roadkill-immune and not a turret target
        tmp.copy(e.aimPoint()).project(this.camera);
        if (tmp.z > 1) continue;                          // behind the camera
        const d = Math.hypot(tmp.x - this.aim.x, tmp.y - this.aim.y);
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    this.lockedTarget = best;

    // Manual turret: you aim, you pull the trigger. Hold Fire (left) or ADS
    // (right-click) — on mobile, the FIRE button. The reticle locks the Wobble
    // under it; a shot hits the lock, or fires a tracer where you're pointing.
    this.fireCd -= dt;
    const shooting = input.isDown('fire') || input.isDown('ads');
    if (shooting && this.fireCd <= 0) {
      this.fireCd = 0.15;
      const muzzle = this.pos.clone().addScaledVector(nf, 0.6); muzzle.y += 2.0;
      if (best) {
        ctx.spawnTracer && ctx.spawnTracer(muzzle, best.aimPoint());
        best.takeDamage(34, { shieldMult: ctx.player ? ctx.player.shieldDmgMult : 1, source: this.pos }); // Goo-Eater perk
        ctx.onHitmark && ctx.onHitmark();
      } else {
        const aimW = new THREE.Vector3(this.aim.x, this.aim.y, 0.5).unproject(this.camera);
        const dir = aimW.sub(this.camera.position).normalize();
        ctx.spawnTracer && ctx.spawnTracer(muzzle, muzzle.clone().addScaledVector(dir, 80));
      }
      ctx.audio && ctx.audio.sfx('rifle');
    }
  }
}
