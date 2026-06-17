// Enemy.js — Wobble Coalition AI. A compact finite state machine: idle → alert
// → chase → attack, with type-specific behaviour (melee swarm, charging bruiser,
// hovering ranged drone, shielded ranged officer, multi-phase boss). Movement is
// steering toward the player with light separation; collisions use Physics.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';
import { ENEMY_META } from '../missions/schema.js';

let _idCounter = 1;

export class Enemy {
  constructor(type, position) {
    this.id = _idCounter++;
    this.type = type;
    this.meta = ENEMY_META[type] || ENEMY_META.blork;
    this.hp = this.meta.hp;
    this.maxHp = this.meta.hp;
    this.shield = this.meta.shield || 0;
    this.maxShield = this.meta.shield || 0;
    this.speed = this.meta.speed;
    this.dead = false;
    this.state = 'idle';
    this.pos = position.clone();
    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.attackCd = Math.random() * 1.2;
    this.alertT = 0;
    this.hunt = false;         // relentless pursuit regardless of range (Survival horde)
    this.wobble = Math.random() * Math.PI * 2;
    this.chargeT = 0;          // gurg charge windup
    this.fuseT = 0;            // popper detonation fuse
    this.blinkCd = 1.4 + Math.random() * 1.4; // blinker teleport timer
    this.deathT = 0;
    this.bossPhase = 1;
    this.bossActT = 2;
    this.mesh = AssetFactory.enemy(type);
    this.mesh.position.copy(this.pos);
    this.radius = type === 'boss' ? 3.0 : type === 'sprocket' ? 1.1 : (this.meta.kind === 'charger' ? 1.0 : 0.55);
    this.height = type === 'boss' ? 6 : type === 'sprocket' ? 3.4 : (type === 'wobbler' ? 2.0 : 1.3);
    this.hover = !!this.meta.hover;
  }

  aimPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + (this.mesh.userData.standHeight || 1), this.pos.z); }

  takeDamage(amount, opts = {}) {
    if (this.dead) return;
    // Bulwark: a heavy frontal shield. Hits landing on the front it's facing are
    // mostly deflected — you have to flank it (its facing turns slowly).
    if (this.meta.kind === 'bulwark' && opts.source) {
      const toSrc = new THREE.Vector3().subVectors(opts.source, this.pos).setY(0);
      if (toSrc.lengthSq() > 0.001) {
        toSrc.normalize();
        const face = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
        if (toSrc.dot(face) > 0.35) {
          amount *= 0.15;
          const plate = this.mesh.userData.plate;
          if (plate && plate.material.emissive) {
            plate.material.emissive.setHex(0x9fd0ff); plate.material.emissiveIntensity = 0.9;
            setTimeout(() => { if (plate.material) plate.material.emissiveIntensity = 0; }, 80);
          }
        }
      }
    }
    // floating damage number (Game wires Enemy.onDamage during play)
    if (Enemy.onDamage) Enemy.onDamage(this.aimPoint(), amount, !!opts.crit);
    let dmg = amount;
    if (this.shield > 0) {
      const sd = dmg * (opts.shieldMult || 1);
      this.shield -= sd;
      if (this.shield < 0) { dmg = -this.shield / (opts.shieldMult || 1); this.shield = 0; }
      else dmg = 0;
      this._flashShield();
    }
    this.hp -= dmg;
    this._flashHit();
    this.alertT = 6; this.state = this.state === 'idle' ? 'alert' : this.state;
    if (this.hp <= 0) this._die(opts.source);
  }

  _flashHit() {
    const b = this.mesh.userData.body;
    if (!b) return;
    b.material.emissive && b.material.emissive.setHex(0xffffff);
    b.material.emissiveIntensity = 0.6;
    setTimeout(() => { if (b.material) { b.material.emissive.setHex(this.type === 'wobbler' ? 0x0 : 0x0); b.material.emissiveIntensity = 0; } }, 60);
  }
  _flashShield() {
    const bub = this.mesh.userData.shieldBubble;
    if (bub) { bub.material.opacity = 0.5; setTimeout(() => { if (bub.material) bub.material.opacity = 0.18; }, 80); }
  }

  _die(source) {
    this.dead = true;
    this.state = 'dead';
    this.deathT = 1.0;
    // comic death: launch and spin
    const away = source ? new THREE.Vector3().subVectors(this.pos, source).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    this.vel.copy(away.multiplyScalar(3)).setY(6);
    const bub = this.mesh.userData.shieldBubble; if (bub) bub.visible = false;
  }

  update(dt, ctx) {
    this.wobble += dt * 6;
    if (this.dead) return this._updateDeath(dt);

    const player = ctx.player;
    const toPlayer = new THREE.Vector3().subVectors(player.pos, this.pos);
    const dist = toPlayer.length();
    const flat = toPlayer.clone().setY(0).normalize();

    // perception
    if (this.state === 'idle') {
      // Normal enemies wake on sight within range; hunters (Survival horde) lock
      // on immediately and chase from anywhere on the map.
      if (this.hunt || (dist < 26 && ctx.physics.hasLineOfSight(this.aimPoint(), player.headPoint()))) { this.state = 'alert'; this.alertT = 0.4; this._squeak(ctx); }
    }
    if (this.alertT > 0) this.alertT -= dt;

    if (this.state !== 'idle') {
      // Bulwark turns slowly (handled in _bulwark) so its frontal shield can be
      // flanked; everyone else snaps to face the player.
      if (this.meta.kind !== 'bulwark') this.facing = Math.atan2(flat.x, flat.z);
      if (this.type === 'boss') this._boss(dt, ctx, dist, flat);
      else if (this.meta.kind === 'sprocket') this._sprocket(dt, ctx, dist, flat);
      else if (this.meta.kind === 'popper') this._popper(dt, ctx, dist, flat);
      else if (this.meta.kind === 'medic') this._medic(dt, ctx, dist, flat);
      else if (this.meta.kind === 'bulwark') this._bulwark(dt, ctx, dist, flat);
      else if (this.meta.kind === 'blinker') this._blinker(dt, ctx, dist, flat);
      else if (this.meta.kind === 'ranged') this._ranged(dt, ctx, dist, flat);
      else if (this.meta.kind === 'charger') this._charger(dt, ctx, dist, flat);
      else this._melee(dt, ctx, dist, flat);
    }

    this._integrate(dt, ctx);
    this._animate(dt);
  }

  _squeak(ctx) { ctx.audio && ctx.audio.sfx(this.type === 'blork' ? 'blork' : this.type === 'gurg' ? 'gurg' : 'wobbler'); }

  _melee(dt, ctx, dist, flat) {
    this.state = 'chase';
    const want = dist > this.meta.range * 0.8 ? this.speed : 0;
    this.vel.x = flat.x * want; this.vel.z = flat.z * want;
    this.attackCd -= dt;
    if (dist < this.meta.range && this.attackCd <= 0) {
      this.attackCd = 1.1;
      ctx.player.takeDamage(this.meta.dmg, this.pos);
    }
  }

  _charger(dt, ctx, dist, flat) {
    // wind up, then a committed lunge it cannot steer out of (comedic)
    if (this.chargeT > 0) {
      this.chargeT -= dt;
      this.vel.x = this._chargeDir.x * this.speed * 3.2;
      this.vel.z = this._chargeDir.z * this.speed * 3.2;
      if (dist < this.meta.range) { this.attackCd -= dt; if (this.attackCd <= 0) { this.attackCd = 1.4; ctx.player.takeDamage(this.meta.dmg, this.pos); } }
    } else {
      this.state = 'chase';
      this.attackCd -= dt;
      if (dist < 14 && this.attackCd <= 0) { this.chargeT = 0.9; this._chargeDir = flat.clone(); this.attackCd = 2.4; ctx.audio && ctx.audio.sfx('gurg'); }
      else { this.vel.x = flat.x * this.speed; this.vel.z = flat.z * this.speed; }
    }
  }

  _ranged(dt, ctx, dist, flat) {
    // keep at preferred range and lob shots; floaters hover
    const pref = this.type === 'wobbler' ? 12 : 16;
    let move = 0;
    if (dist > pref + 4) move = this.speed;
    else if (dist < pref - 4) move = -this.speed;
    this.vel.x = flat.x * move; this.vel.z = flat.z * move;
    if (this.hover) this.pos.y = 2.2 + Math.sin(this.wobble * 0.5) * 0.4;

    this.attackCd -= dt;
    if (this.attackCd <= 0 && dist < this.meta.range && ctx.physics.hasLineOfSight(this.aimPoint(), ctx.player.headPoint())) {
      this.attackCd = this.type === 'wobbler' ? 1.8 : 1.3;
      const origin = this.aimPoint();
      const dir = new THREE.Vector3().subVectors(ctx.player.headPoint(), origin).normalize();
      // lead/arc: lob slightly upward
      const speed = 24;
      const vel = dir.multiplyScalar(speed); vel.y += 2.5;
      ctx.spawnProjectile && ctx.spawnProjectile({ type: 'goo', owner: 'enemy', pos: origin, vel, damage: this.meta.dmg, gravity: -8, life: 4 });
      ctx.audio && ctx.audio.sfx('goocaster');
    }
  }

  _boss(dt, ctx, dist, flat) {
    this.state = 'boss';
    // slowly track the player; cycle attacks
    this.vel.x = flat.x * this.speed; this.vel.z = flat.z * this.speed;
    this.bossActT -= dt;
    this.bossPhase = this.hp > this.maxHp * 0.66 ? 1 : this.hp > this.maxHp * 0.33 ? 2 : 3;
    if (this.bossActT <= 0) {
      this.bossActT = Math.max(1.2, 3.0 - this.bossPhase * 0.5);
      const pick = Math.floor(this.wobble) % 3;
      if (pick === 0) {
        // goo barrage
        for (let i = -2; i <= 2; i++) {
          const dir = new THREE.Vector3().subVectors(ctx.player.headPoint(), this.aimPoint()).normalize();
          dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.12);
          ctx.spawnProjectile && ctx.spawnProjectile({ type: 'bossbolt', owner: 'enemy', pos: this.aimPoint(), vel: dir.multiplyScalar(30), damage: 14, splash: 2, life: 4 });
        }
        ctx.audio && ctx.audio.sfx('goocaster');
      } else if (pick === 1 && ctx.requestSpawn) {
        // spawn a couple of blork adds
        ctx.requestSpawn('blork', 2, this.pos);
        ctx.audio && ctx.audio.sfx('wobbler');
      } else if (dist < 6) {
        ctx.player.takeDamage(this.meta.dmg, this.pos);
        ctx.shake && ctx.shake(0.5);
        ctx.audio && ctx.audio.sfx('gurg');
      }
    }
  }

  // Quivermaster Sprocket — a shielded, strafing mini-boss that cycles three
  // tells: a fan of quill-shards, a summon of Bobbins drones, and a lobbed goo.
  // Two phases: he gets twitchier under half health.
  _sprocket(dt, ctx, dist, flat) {
    this.state = 'miniboss';
    const pref = 16;
    let move = 0;
    if (dist > pref + 4) move = this.speed; else if (dist < pref - 3) move = -this.speed;
    const strafe = Math.sin(this.wobble * 0.4) * this.speed * 0.55; // sidestep to dodge
    const right = new THREE.Vector3(flat.z, 0, -flat.x);
    this.vel.x = flat.x * move + right.x * strafe;
    this.vel.z = flat.z * move + right.z * strafe;

    this.bossPhase = this.hp > this.maxHp * 0.5 ? 1 : 2;
    this.bossActT -= dt;
    if (this.bossActT <= 0) {
      this.bossActT = Math.max(1.3, 2.6 - this.bossPhase * 0.5);
      const pick = Math.floor(this.wobble) % 3;
      const origin = this.aimPoint();
      if (pick === 0) {
        // quill fan
        const n = this.bossPhase === 2 ? 3 : 2;
        for (let i = -n; i <= n; i++) {
          const dir = new THREE.Vector3().subVectors(ctx.player.headPoint(), origin).normalize();
          dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.14);
          ctx.spawnProjectile && ctx.spawnProjectile({ type: 'shard', owner: 'enemy', pos: origin, vel: dir.multiplyScalar(36), damage: 8, life: 4 });
        }
        ctx.audio && ctx.audio.sfx('stinger');
      } else if (pick === 1 && ctx.requestSpawn) {
        ctx.requestSpawn('floater', this.bossPhase === 2 ? 3 : 2, this.pos);
        ctx.audio && ctx.audio.sfx('wobbler');
      } else {
        const dir = new THREE.Vector3().subVectors(ctx.player.headPoint(), origin).normalize();
        const vel = dir.multiplyScalar(26); vel.y += 2.5;
        ctx.spawnProjectile && ctx.spawnProjectile({ type: 'goo', owner: 'enemy', pos: origin, vel, damage: this.meta.dmg, gravity: -8, splash: 1.5, life: 4 });
        ctx.audio && ctx.audio.sfx('goocaster');
      }
    }
  }

  // Goober Popper — a fast suicide rusher. Sprints at you and, on contact, lights
  // a short fuse, then detonates in a goo blast. Kill it at range to stay clear.
  _popper(dt, ctx, dist, flat) {
    this.state = 'chase';
    if (this.fuseT > 0) {
      this.vel.x = 0; this.vel.z = 0;
      this.fuseT -= dt;
      const core = this.mesh.userData.popCore;
      if (core) core.material.emissiveIntensity = 0.8 + Math.abs(Math.sin(this.wobble * 9)) * 1.5;
      if (this.fuseT <= 0) this._detonate(ctx);
      return;
    }
    this.vel.x = flat.x * this.speed; this.vel.z = flat.z * this.speed;
    if (dist < this.meta.range) { this.fuseT = 0.45; ctx.audio && ctx.audio.sfx('nadetick'); }
  }
  _detonate(ctx) {
    const R = 4.4;
    ctx.spawnExplosion && ctx.spawnExplosion(this.pos.clone().setY(1.0), R);
    if (ctx.player.pos.distanceTo(this.pos) < R) ctx.player.takeDamage(this.meta.dmg, this.pos);
    ctx.shake && ctx.shake(0.5);
    ctx.audio && ctx.audio.sfx('explosion');
    this._die(ctx.player.pos);
  }

  // Mendbot — a floating support drone. No attack; it hangs back and pulses heals
  // (plus a little shield) into the nearest wounded ally. Kill it first.
  _medic(dt, ctx, dist, flat) {
    this.state = 'alert';
    const pref = 14;
    let move = 0;
    if (dist < pref) move = -this.speed; else if (dist > pref + 7) move = this.speed * 0.6;
    this.vel.x = flat.x * move; this.vel.z = flat.z * move;
    if (this.hover) this.pos.y = 2.4 + Math.sin(this.wobble * 0.5) * 0.3;
    this.attackCd -= dt;
    if (this.attackCd <= 0) {
      this.attackCd = 1.6;
      let best = null, bestD = 16;
      for (const e of (ctx.enemies || [])) {
        if (e === this || e.dead || e.meta.kind === 'medic') continue;
        if (e.hp >= e.maxHp && e.shield >= e.maxShield) continue;
        const d = this.pos.distanceTo(e.pos);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        best.hp = Math.min(best.maxHp, best.hp + 14);
        if (best.maxShield) best.shield = Math.min(best.maxShield, best.shield + 8);
        ctx.spawnImpact && ctx.spawnImpact(best.aimPoint(), 'heal');     // green pulse on the ally
        ctx.spawnImpact && ctx.spawnImpact(this.aimPoint(), 'heal');
        ctx.audio && ctx.audio.sfx('shieldrecharge');
      }
    }
  }

  // Bulwark Blob — slow, very tanky, with a frontal shield (see takeDamage). It
  // grinds toward you and bashes up close; circle-strafe to hit its open back.
  _bulwark(dt, ctx, dist, flat) {
    this.state = 'chase';
    const target = Math.atan2(flat.x, flat.z);
    let d = target - this.facing;
    while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    this.facing += d * Math.min(1, dt * 1.7);          // slow turn -> flankable
    const want = dist > this.meta.range * 0.85 ? this.speed : 0;
    this.vel.x = flat.x * want; this.vel.z = flat.z * want;
    this.attackCd -= dt;
    if (dist < this.meta.range && this.attackCd <= 0) { this.attackCd = 1.3; ctx.player.takeDamage(this.meta.dmg, this.pos); }
  }

  // Blip — a ranged harasser that teleports every couple of seconds to throw off
  // your aim. Lead it, or catch it right after it blinks.
  _blinker(dt, ctx, dist, flat) {
    this._ranged(dt, ctx, dist, flat);                 // base: keep range + lob goo
    this.blinkCd -= dt;
    if (this.blinkCd <= 0) {
      this.blinkCd = 1.3 + Math.random() * 1.5;
      ctx.spawnImpact && ctx.spawnImpact(this.aimPoint(), 'blink');
      const ang = Math.random() * Math.PI * 2, hop = 5 + Math.random() * 3;
      this.pos.x += Math.cos(ang) * hop;
      this.pos.z += Math.sin(ang) * hop;
      this.mesh.position.copy(this.pos);
      ctx.spawnImpact && ctx.spawnImpact(this.aimPoint(), 'blink');
      ctx.audio && ctx.audio.sfx('scopein');
    }
  }

  _integrate(dt, ctx) {
    // separation from other enemies (gentle, so swarms don't stack)
    if (ctx.enemies && this.type !== 'boss') {
      for (const o of ctx.enemies) {
        if (o === this || o.dead) continue;
        const d = this.pos.distanceTo(o.pos);
        if (d > 0.001 && d < this.radius + o.radius) {
          const push = new THREE.Vector3().subVectors(this.pos, o.pos).setY(0).normalize().multiplyScalar((this.radius + o.radius - d) * 4);
          this.vel.add(push);
        }
      }
    }
    if (!this.hover) this.vel.y += ctx.physics.gravity * dt;
    const res = ctx.physics.moveAndCollide(this.pos, this.vel, dt, this.radius, this.height);
    if (this.hover) { this.vel.y = 0; }
    else if (res.grounded) this.vel.y = 0;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.facing;
  }

  _animate(dt) {
    // jiggle: squash/stretch the body for goofiness
    const b = this.mesh.userData.body;
    if (b) {
      const j = 1 + Math.sin(this.wobble) * 0.06;
      b.scale.y = (this.type === 'wobbler' ? 1 : (this.type === 'gurg' ? 0.85 : 1.05)) * j;
      b.scale.x = b.scale.z = 1 / Math.sqrt(j);
    }
    const bulb = this.mesh.userData.antennaBulb;
    if (bulb) bulb.position.x = Math.sin(this.wobble * 0.7) * 0.08;
  }

  _updateDeath(dt) {
    this.deathT -= dt;
    this.vel.y += -18 * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < 0.1) { this.pos.y = 0.1; this.vel.set(0, 0, 0); }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += dt * 8;
    this.mesh.rotation.z += dt * 6;
    const s = Math.max(0.01, this.deathT);
    this.mesh.scale.setScalar(s);
    return;
  }
}
