// Projectile.js — travelling shots (player goo/shards/grenades and enemy goo).
// Owner determines what it can damage. Goo/shards fly straight (shards lightly
// home) and pop on contact. Grenades arc under gravity and run on a fuse: frags
// bounce off the world and glance off enemies until the timer pops; goobers
// stick to the first surface or enemy they touch, then detonate shortly after.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';

let _pidCounter = 1;

export class Projectile {
  constructor(opts) {
    this.id = _pidCounter++;          // stable id for co-op ghost reconciliation
    this.type = opts.type;            // 'goo' | 'shard' | 'grenade' | 'bossbolt' | enemy 'goo'
    this.owner = opts.owner;          // 'player' | 'enemy'
    this.ownerPlayer = opts.ownerPlayer || null;   // the firing Player (PvP: frag attribution + targets)
    this.pos = opts.pos.clone();
    this.vel = opts.vel.clone();
    this.damage = opts.damage || 10;
    this.splash = opts.splash || 0;
    this.gravity = opts.gravity || 0;
    this.life = opts.life || 4;
    this.homing = opts.homing || false;
    this.homingTarget = opts.homingTarget || null; // the locked aimed-at enemy (if any)
    this.shieldMult = opts.shieldMult || 1;
    this.dead = false;
    this.fuse = opts.fuse || null;    // grenades
    this.bounce = opts.bounce || 0;   // restitution (frag grenades)
    this.sticky = opts.sticky || false;
    this.stuckTo = null;              // enemy a goober is riding
    this.radius = this.type === 'grenade' ? 0.16 : 0.05;
    this.mesh = AssetFactory.projectileMesh(this.type);
    this.mesh.position.copy(this.pos);
  }

  update(dt, ctx) {
    if (this.dead) return;
    this.life -= dt;
    if (this.fuse !== null) { this.fuse -= dt; if (this.fuse <= 0) return this.explode(ctx); }
    if (this.life <= 0) { this.dead = true; return; }

    // a stuck goober rides its enemy until the fuse pops (and stays glued to
    // the corpse while its death tumble is still visible)
    if (this.stuckTo) {
      if (!this.stuckTo.dead || this.stuckTo.deathT > 0) this.pos.copy(this.stuckTo.aimPoint());
      this.mesh.position.copy(this.pos);
      return;
    }
    // planted on a surface: nothing to do but wait for the fuse
    if (this._stuck) return;

    const owned = this.owner === 'player' ? (ctx.combatTargets ? ctx.combatTargets(this.ownerPlayer) : ctx.enemies) : null;
    if (this.homing && owned) {
      // Chase the locked aimed-at target; if it's gone, re-acquire the nearest
      // body (so a shot into a cluster keeps finding fresh Wobble).
      let target = (this.homingTarget && !this.homingTarget.dead) ? this.homingTarget : null;
      if (!target) {
        this.homingTarget = null;
        let bestD = 28;
        for (const e of owned) {
          if (e.dead) continue;
          const d = e.pos.distanceTo(this.pos);
          if (d < bestD) { bestD = d; target = e; }
        }
      }
      if (target) {
        const want = new THREE.Vector3().subVectors(target.aimPoint(), this.pos).normalize().multiplyScalar(this.vel.length());
        this.vel.lerp(want, Math.min(1, dt * 5));
      }
    }

    this.vel.y += this.gravity * dt;
    const prev = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    if (this.type === 'shard') this.mesh.lookAt(this.pos.clone().add(this.vel));
    const isNade = this.type === 'grenade';

    // floor
    if (this.pos.y <= this.radius) {
      this.pos.y = this.radius;
      if (!isNade) { this.mesh.position.copy(this.pos); return this._impact(ctx); }
      if (this.sticky) return this._stickAt(ctx);
      if (this.vel.y < -2.5) {
        this.vel.y = -this.vel.y * this.bounce;
        this.vel.x *= 0.6; this.vel.z *= 0.6;
        ctx.audio && ctx.audio.sfx('nadebounce');
      } else {
        // settled: roll along the ground and bleed speed
        this.vel.y = 0;
        const f = Math.max(0, 1 - 5 * dt);
        this.vel.x *= f; this.vel.z *= f;
      }
    }

    // walls / props
    const step = prev.distanceTo(this.pos);
    if (step > 0 && ctx.physics) {
      const dir = new THREE.Vector3().subVectors(this.pos, prev).divideScalar(step);
      const hit = ctx.physics.raycastWorldHit(prev, dir, step + this.radius);
      if (hit) {
        if (!isNade) return this._impact(ctx);
        this.pos.copy(prev).addScaledVector(dir, Math.max(0, hit.dist - this.radius));
        if (this.sticky) return this._stickAt(ctx);
        // frag: reflect off the surface and lose energy
        const vn = this.vel.dot(hit.normal);
        this.vel.addScaledVector(hit.normal, -2 * vn);
        this.vel.multiplyScalar(this.bounce);
        if (Math.abs(vn) > 2.5) ctx.audio && ctx.audio.sfx('nadebounce');
      }
    }
    this.mesh.position.copy(this.pos);

    // entity collision
    if (this.owner === 'player' && (ctx.combatTargets ? ctx.combatTargets(this.ownerPlayer) : ctx.enemies)) {
      for (const e of (ctx.combatTargets ? ctx.combatTargets(this.ownerPlayer) : ctx.enemies)) {
        if (e.dead) continue;
        if (this.pos.distanceTo(e.aimPoint()) < 0.9) {
          if (isNade) {
            if (this.sticky) return this._stickTo(e, ctx);
            // frag: glance off — the fuse does the killing
            const n = new THREE.Vector3().subVectors(this.pos, e.aimPoint()).normalize();
            const into = this.vel.dot(n);
            if (into < 0) this.vel.addScaledVector(n, -1.7 * into);
            this.vel.multiplyScalar(0.6);
            // push out of the enemy, but never into world geometry
            const clear = ctx.physics ? ctx.physics.raycastWorld(e.aimPoint(), n, 0.95 + this.radius) : 0.95 + this.radius;
            this.pos.copy(e.aimPoint()).addScaledVector(n, Math.max(0, Math.min(0.95, clear - this.radius)));
            this.mesh.position.copy(this.pos);
            ctx.audio && ctx.audio.sfx('nadebounce');
            break;
          }
          e.takeDamage(this.damage, { shieldMult: this.shieldMult, source: this.pos, attacker: this.ownerPlayer });
          ctx.audio && ctx.audio.sfx('hitmark');
          ctx.onHitmark && ctx.onHitmark();
          return this.splash ? this.explode(ctx) : this._impact(ctx);
        }
      }
    } else if (this.owner === 'enemy' && ctx.players) {
      for (const pl of ctx.players) {
        if (!pl || pl.dead || pl.downed) continue;
        if (this.pos.distanceTo(pl.headPoint()) < 1.0) {
          pl.takeDamage(this.damage, this.pos);
          return this.splash ? this.explode(ctx) : this._impact(ctx);
        }
      }
    }
  }

  _stickAt(ctx) {
    // goober: plant where it landed and arm the short fuse
    if (this._stuck) return;
    this._stuck = true;
    this.vel.set(0, 0, 0);
    this.gravity = 0;
    if (this.fuse === null || this.fuse > 0.8) this.fuse = 0.8;
    if (this.mesh.material) this.mesh.material.emissiveIntensity = 1.6;
    this.mesh.position.copy(this.pos);
    ctx.audio && ctx.audio.sfx('stick');
  }

  _stickTo(e, ctx) {
    // goober: glue itself to an enemy
    this.stuckTo = e;
    if (this.fuse === null || this.fuse > 0.6) this.fuse = 0.6;
    if (this.mesh.material) this.mesh.material.emissiveIntensity = 1.6;
    ctx.audio && ctx.audio.sfx('stick');
  }

  _impact(ctx) {
    this.dead = true;
    ctx.spawnImpact && ctx.spawnImpact(this.pos, this.type);
  }

  explode(ctx) {
    this.dead = true;
    ctx.audio && ctx.audio.sfx('explosion');
    ctx.spawnExplosion && ctx.spawnExplosion(this.pos, this.splash || 2.5);
    const r = this.splash || 2.5;
    if (this.owner === 'player') {
      const tgts = ctx.combatTargets ? ctx.combatTargets(this.ownerPlayer) : ctx.enemies;   // enemies, or PvP foes
      for (const e of tgts) {
        if (e.dead) continue;
        const d = e.aimPoint().distanceTo(this.pos);
        if (d < r) e.takeDamage(this.damage * (1 - d / r) + this.damage * 0.4, { shieldMult: this.shieldMult, source: this.pos, attacker: this.ownerPlayer });
      }
      // your own grenades are not your friends (cooked too long / bounced back) —
      // and in co-op they're not your buddy's friends either. Skip anyone already
      // hit as a combat target above (PvP foes) so they don't take splash twice.
      if (this.type === 'grenade' && ctx.players) {
        for (const pl of ctx.players) {
          if (!pl || pl.dead || pl.downed || tgts.indexOf(pl) !== -1) continue;
          const d = pl.headPoint().distanceTo(this.pos);
          if (d < r) pl.takeDamage(this.damage * (1 - d / r) * 0.5, this.pos);
        }
      }
    } else if (this.owner === 'enemy' && ctx.players) {
      for (const pl of ctx.players) {
        if (!pl || pl.dead || pl.downed) continue;
        const d = pl.headPoint().distanceTo(this.pos);
        if (d < r) pl.takeDamage(this.damage * (1 - d / r), this.pos);
      }
    }
  }
}
