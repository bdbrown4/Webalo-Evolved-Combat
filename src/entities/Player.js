// Player.js — first-person controller. Recharging shields over a health pool
// (shields absorb first, regen after a delay; health only regenerates via
// pickups), two-weapon carry with swap + reload, two grenade types, melee, and
// hitscan firing resolved against enemies and world geometry.

import * as THREE from 'three';
import { Weapon, WEAPONS } from './Weapon.js';

const SHIELD_MAX = 70;
const HEALTH_MAX = 45;
const SHIELD_REGEN_DELAY = 3.0;
const SHIELD_REGEN_RATE = 38;
const FRAG_FUSE = 2.2; // starts burning the moment the pin is pulled (cookable)

export class Player {
  constructor(camera, spawn) {
    this.camera = camera;
    this.pos = new THREE.Vector3(spawn.x, spawn.y || 0, spawn.z);
    this.vel = new THREE.Vector3();
    this.yaw = spawn.yaw || 0;
    this.pitch = 0;
    this.radius = 0.4;
    this.height = 1.7;
    this.crouchHeight = 1.1;
    this.curHeight = this.height;
    this.grounded = false;

    // base stats (instance-level so between-mission perks can scale them)
    this.shieldMax = SHIELD_MAX;
    this.healthMax = HEALTH_MAX;
    this.shieldRegen = SHIELD_REGEN_RATE;
    this.shieldRegenDelay = SHIELD_REGEN_DELAY;
    this.healMult = 1;          // perk: Field Rations
    this.moveMult = 1;          // perk: Light Step
    this.shieldDmgMult = 1;     // perk: Goo-Eater (vs enemy shields)
    this.healOnKill = 0;        // perk: Goo Siphon
    this.reloadMult = 1;        // perk: Quick Hands (mirrored onto weapons)
    this.grenadeBonus = 0;      // perk: Bandolier
    this.shield = this.shieldMax;
    this.health = this.healthMax;
    this.regenT = 0;
    this.dead = false;

    this.weapons = [];
    this.current = 0;
    this.grenades = { frag: 2, goober: 1 };
    this.grenadeType = 'frag';
    this.cooking = null;     // { sticky, fuse, max } while a primed grenade is held
    this.nadeEvent = null;   // 'thrown' | 'cancelled' — consumed by Game for the hand anim
    this.meleeEvent = false;  // set on a melee swing — consumed by Game for the fist anim
    this._cookBeep = 0;
    this.meleeCd = 0;
    this.driving = false;       // true while mounted in a Vehicle (escape finale)
    this.dmgTakenMult = 1;      // set from the selected difficulty
    this.bobT = 0;
    this.lastHitFlash = 0;
    this.justFired = 0;

    // Headlamp: a camera-mounted spotlight toggled by the 'flashlight' action.
    // Clear any flashlight left on the (shared) camera by a previous mission's
    // Player so they don't accumulate across restarts.
    for (let i = this.camera.children.length - 1; i >= 0; i--) {
      const c = this.camera.children[i];
      if (c.isSpotLight || (c.userData && c.userData.isFlashTarget)) this.camera.remove(c);
    }
    this.flashlight = new THREE.SpotLight(0xfff0d0, 0, 55, Math.PI / 6, 0.5, 1.0);
    this.flashlight.position.set(0, 0, 0.1);
    this.flashlight.target.position.set(0, 0, -1);
    this.flashlight.target.userData.isFlashTarget = true;
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlight.target);
    this._flashlightOn = false;

    this._tmp = new THREE.Vector3();
  }

  giveWeapon(key) {
    if (!WEAPONS[key]) return;
    const existing = this.weapons.find((w) => w.key === key);
    if (existing) { existing.addReserve(existing.def.magazine * 2); return; }
    const made = new Weapon(key); made.reloadMult = this.reloadMult; // carry the Quick Hands perk
    if (this.weapons.length < 2) { this.weapons.push(made); }
    else { this.weapons[this.current] = made; }
  }

  get weapon() { return this.weapons[this.current] || null; }

  swapWeapon() {
    if (this.weapons.length < 2) return false;
    this.current = (this.current + 1) % this.weapons.length;
    if (this.weapon) this.weapon.reloading = 0;
    return true;
  }
  selectWeapon(i) {
    if (!this.weapons[i] || i === this.current) return false;
    this.current = i;
    if (this.weapon) this.weapon.reloading = 0;
    return true;
  }

  cycleGrenade() { this.grenadeType = this.grenadeType === 'frag' ? 'goober' : 'frag'; }

  // Refund a primed grenade on involuntary interrupts (pause, pointer-lock
  // loss, vehicle mount) so it is never auto-thrown or silently lost.
  cancelCook() {
    if (!this.cooking) return;
    this.grenades[this.cooking.sticky ? 'goober' : 'frag'] += 1;
    this.cooking = null;
    this.nadeEvent = 'cancelled';
  }

  headPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + this.curHeight * 0.92, this.pos.z); }

  lookDir() {
    return new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();
  }

  takeDamage(amount, sourcePos) {
    if (this.dead || amount <= 0) return;
    amount *= this.dmgTakenMult; // difficulty scaling
    this.regenT = 0;
    this.lastHitFlash = 0.3;
    const wasShielded = this.shield > 0;
    if (this.shield > 0) {
      this.shield -= amount;
      if (this.shield < 0) { this.health += this.shield; this.shield = 0; this._brokeShield = true; }
    } else {
      this.health -= amount;
    }
    this._dmgSfx = wasShielded && this.shield > 0 ? 'shieldhit' : 'hurt';
    if (this._brokeShield) { this._dmgSfx = 'shieldbreak'; this._brokeShield = false; }
    if (this.health <= 0) { this.health = 0; this.dead = true; }
  }

  addHealth(amount) { this.health = Math.min(this.healthMax, this.health + amount * this.healMult); }

  update(dt, input, settings, ctx) {
    if (this.dead) return;
    if (this.remote) {
      // Co-op host-side guest: its transform is applied from the network just
      // before this call. We run shields + combat so the HOST authoritatively
      // resolves the guest's shots/reloads/swaps/grenades through the same code
      // paths as any player — movement/look are trusted from the packet, so we
      // skip _look/_move/_syncCamera (no real camera on a remote player anyway).
      this._regen(dt, ctx);
      if (this.weapon) this.weapon.update(dt);
      this._combat(dt, input, ctx);
      if (this.meleeCd > 0) this.meleeCd -= dt;
      if (this.lastHitFlash > 0) this.lastHitFlash -= dt;
      if (this.justFired > 0) this.justFired -= dt;
      return;
    }
    if (this.driving) {
      // While mounted, the Vehicle owns movement + camera. Keep shields/weapons ticking.
      this._regen(dt, ctx);
      if (this.weapon) this.weapon.update(dt);
      if (this.lastHitFlash > 0) this.lastHitFlash -= dt;
      return;
    }
    this._look(input, settings);
    this._move(dt, input, settings, ctx);
    this._regen(dt, ctx);
    if (this.weapon) this.weapon.update(dt);
    this._combat(dt, input, ctx);
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this.lastHitFlash > 0) this.lastHitFlash -= dt;
    if (this.justFired > 0) this.justFired -= dt;
    this._syncCamera(settings, dt);
  }

  // Co-op guest-side: this client's OWN player. We predict movement + look
  // locally (instant, responsive) against our local copy of the arena, and ship
  // the resulting transform to the host. Firing/shields/ammo are the host's job
  // (mirrored back via snapshot), so no _combat/_regen here — the host runs them.
  updateGuest(dt, input, settings, ctx) {
    if (this.dead) { this._syncCamera(settings, dt); return; }
    this._look(input, settings);
    this._move(dt, input, settings, ctx);
    if (this.weapon) this.weapon.update(dt); // keep the view-model cooldown honest
    this._syncCamera(settings, dt);
  }

  _look(input, settings) {
    const s = settings.data.mouse.sensitivity * 0.0022;
    const adsing = this.weapon && input.isDown('ads');
    const scale = adsing ? settings.data.mouse.adsScale : 1;
    this.yaw -= input.mouseDX * s * scale;
    this.pitch -= input.mouseDY * s * scale * (settings.data.mouse.invertY ? -1 : 1);
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  _move(dt, input, settings, ctx) {
    const crouching = input.isDown('crouch');
    const targetH = crouching ? this.crouchHeight : this.height;
    this.curHeight += (targetH - this.curHeight) * Math.min(1, dt * 10);

    const sprint = input.isDown('sprint') && input.isDown('forward') && !crouching;
    const base = crouching ? 3.0 : 5.4;
    const speed = (sprint ? 8.2 : base) * this.moveMult;

    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // screen-right = forward × up; with +Z-forward at yaw 0 that is (-cos, 0, sin)
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (input.isDown('forward')) wish.add(fwd);
    if (input.isDown('back')) wish.sub(fwd);
    if (input.isDown('right')) wish.add(right);
    if (input.isDown('left')) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize();

    // accelerate horizontally toward wish velocity (snappy arcade control)
    const targetVX = wish.x * speed, targetVZ = wish.z * speed;
    const accel = this.grounded ? 18 : 6;
    this.vel.x += (targetVX - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (targetVZ - this.vel.z) * Math.min(1, accel * dt);

    if (input.pressed('jump') && this.grounded) { this.vel.y = 8.2; this.grounded = false; }
    this.vel.y += ctx.physics.gravity * dt;

    const res = ctx.physics.moveAndCollide(this.pos, this.vel, dt, this.radius, this.curHeight);
    this.grounded = res.grounded;
    if (this.grounded && this.vel.y < 0) this.vel.y = 0;

    if (this.grounded && wish.lengthSq() > 0 && settings.data.video.viewBob) {
      this.bobT += dt * (sprint ? 14 : 9);
    }
    this.isSprinting = sprint;
  }

  _regen(dt, ctx) {
    if (this.regenT < this.shieldRegenDelay) {
      this.regenT += dt;
    } else if (this.shield < this.shieldMax) {
      const before = this.shield;
      this.shield = Math.min(this.shieldMax, this.shield + this.shieldRegen * dt);
      if (before <= 0 && this.shield > 0) ctx.audio && ctx.audio.sfx('shieldrecharge');
    }
  }

  _combat(dt, input, ctx) {
    if (input.pressed('swap') && this.swapWeapon()) ctx.audio && ctx.audio.sfx('swap');
    if (input.pressed('flashlight')) { this._flashlightOn = !this._flashlightOn; this.flashlight.intensity = this._flashlightOn ? 8 : 0; ctx.audio && ctx.audio.sfx('ui'); }
    const wheel = input.takeWheel ? input.takeWheel() : 0;
    if (wheel && this.swapWeapon()) ctx.audio && ctx.audio.sfx('swap');
    if (input.pressed('weapon1') && this.selectWeapon(0)) ctx.audio && ctx.audio.sfx('swap');
    if (input.pressed('weapon2') && this.selectWeapon(1)) ctx.audio && ctx.audio.sfx('swap');
    if (input.pressed('nadeswap')) { this.cycleGrenade(); ctx.audio && ctx.audio.sfx('ui'); }
    if (input.pressed('reload') && this.weapon) { if (this.weapon.startReload()) ctx.audio && ctx.audio.sfx('reload'); }
    if (input.pressed('melee') && this.meleeCd <= 0 && !this.cooking) this._melee(ctx); // no pistol-whip mid-cook
    if (input.pressed('grenade')) this._primeGrenade(ctx);
    if (this.cooking) this._updateCook(dt, input, ctx);

    if (!this.weapon) return;
    const def = this.weapon.def;
    const wantFire = def.auto ? input.isDown('fire') : input.pressed('fire');
    if (wantFire) {
      if (this.weapon.needsReload()) { if (this.weapon.startReload()) ctx.audio && ctx.audio.sfx('reload'); }
      else if (this.weapon.canFire()) this._fire(ctx, input.isDown('ads'));
    }
  }

  // Alt-fire (hold ADS while firing) merges the weapon's `alt` overrides over its
  // base def: Boomstick slug, Goocaster blast, Stinger volley. Weapons with no
  // `alt` just fire normally while aiming.
  _fire(ctx, useAlt) {
    const w = this.weapon, base = w.def;
    const isAlt = !!(useAlt && base.alt);
    const def = isAlt ? Object.assign({}, base, base.alt) : base;
    w.consume();                                  // -1 ammo, cooldown = 1 / base.fireRate
    if (isAlt) {
      w.cooldown = 1 / def.fireRate;              // alt cadence
      if (def.ammoCost > 1) w.ammo = Math.max(0, w.ammo - (def.ammoCost - 1)); // alt may cost extra
    }
    this.justFired = 0.06;
    ctx.audio && ctx.audio.sfx(def.sfx);
    ctx.onMuzzleFlash && ctx.onMuzzleFlash(def);

    const origin = this.headPoint();
    if (def.mode === 'projectile') {
      // Homing shots lock onto whatever you're actually aiming at, not just the
      // nearest body — the projectile falls back to nearest only if that target dies.
      const homingTarget = def.homing ? this._aimTarget(origin, this.lookDir(), ctx) : null;
      for (let s = 0; s < (def.burst || 1); s++) {  // burst = a multi-shot volley (Stinger alt)
        const dir = this._spreadDir(def.spread);
        ctx.spawnProjectile && ctx.spawnProjectile({
          type: def.projectile, owner: 'player', pos: origin,
          vel: dir.multiplyScalar(def.projectileSpeed), damage: def.damage,
          splash: def.splash || 0, shieldMult: (def.shieldMult || 1) * this.shieldDmgMult, homing: !!def.homing, homingTarget, life: 4,
        });
      }
      return;
    }
    // hitscan, possibly multi-pellet
    let anyHit = false;
    for (let p = 0; p < (def.pellets || 1); p++) {
      const dir = this._spreadDir(def.spread);
      const hit = this._hitscan(origin, dir, def, ctx);
      anyHit = anyHit || hit;
    }
    if (anyHit) { ctx.audio && ctx.audio.sfx('hitmark'); ctx.onHitmark && ctx.onHitmark(); }
  }

  // The enemy you're aiming at: the one whose direction best matches the look
  // ray, within a soft cone. In a tight cluster this picks the most centred body;
  // the homing projectile re-acquires nearest if that one dies (group sweep).
  _aimTarget(origin, dir, ctx, minDot = 0.97) {
    let best = null, bestDot = minDot;
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const to = this._tmp.subVectors(e.aimPoint(), origin);
      const dist = to.length();
      if (dist < 0.001 || dist > 90) continue;
      const dot = to.multiplyScalar(1 / dist).dot(dir);
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
    return best;
  }

  _spreadDir(spread) {
    const d = this.lookDir();
    if (spread > 0) {
      d.x += (Math.random() - 0.5) * spread * 2;
      d.y += (Math.random() - 0.5) * spread * 2;
      d.z += (Math.random() - 0.5) * spread * 2;
      d.normalize();
    }
    return d;
  }

  _hitscan(origin, dir, def, ctx) {
    const wallDist = ctx.physics.raycastWorld(origin, dir, def.range);
    let bestT = Math.min(def.range, wallDist);
    let target = null, headshot = false;
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const hit = this._raySphere(origin, dir, e.aimPoint(), e.type === 'boss' ? 3.2 : 0.7);
      if (hit !== null && hit < bestT) {
        bestT = hit; target = e;
        const headY = e.aimPoint().y + (e.type === 'boss' ? 1.5 : 0.4);
        const hitY = origin.y + dir.y * hit;
        headshot = hitY > headY - 0.15;
      }
    }
    const point = origin.clone().addScaledVector(dir, bestT);
    if (target) {
      let dmg = def.damage * (headshot ? (def.headshotMult || 1) : 1);
      target.takeDamage(dmg, { shieldMult: (def.shieldMult || 1) * this.shieldDmgMult, source: origin, crit: headshot });
      if (def.knockback) target.vel.add(dir.clone().setY(0).multiplyScalar(def.knockback));
      ctx.spawnTracer && ctx.spawnTracer(origin, point);
      return true;
    }
    ctx.spawnTracer && ctx.spawnTracer(origin, point);
    if (bestT < def.range) ctx.spawnImpact && ctx.spawnImpact(point, 'spark');
    return false;
  }

  _raySphere(o, d, center, r) {
    const m = this._tmp.subVectors(o, center);
    const b = m.dot(d);
    const c = m.dot(m) - r * r;
    if (c > 0 && b > 0) return null;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t < 0 ? 0 : t;
  }

  _melee(ctx) {
    this.meleeCd = 0.6;
    this.meleeEvent = true; // Game plays the fist-jab view-model
    ctx.audio && ctx.audio.sfx('melee');
    const origin = this.headPoint(), dir = this.lookDir();
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const to = new THREE.Vector3().subVectors(e.aimPoint(), origin);
      if (to.length() < 2.4 && to.normalize().dot(dir) > 0.5) {
        e.takeDamage(55, { shieldMult: 1.5, source: origin });
        e.vel.add(dir.clone().setY(0.2).multiplyScalar(7));
      }
    }
  }

  // Press: pull the pin (frag fuse starts burning — "cooking"). Release: throw
  // with whatever fuse is left. Hold a frag too long and it goes off in hand.
  // Goobers don't cook (their fuse arms on impact) but share release-to-throw.
  _primeGrenade(ctx) {
    if (this.cooking || this.grenades[this.grenadeType] <= 0) return;
    this.grenades[this.grenadeType] -= 1;
    ctx.audio && ctx.audio.sfx('grenade');
    const sticky = this.grenadeType === 'goober';
    this.cooking = { sticky, fuse: FRAG_FUSE, max: FRAG_FUSE };
    this._cookBeep = 0.3;
  }

  _updateCook(dt, input, ctx) {
    const c = this.cooking;
    if (!c.sticky) {
      c.fuse -= dt;
      this._cookBeep -= dt;
      if (this._cookBeep <= 0) {
        this._cookBeep = Math.max(0.08, (c.fuse / c.max) * 0.4); // beeps speed up
        ctx.audio && ctx.audio.sfx('nadetick');
      }
      if (c.fuse <= 0) {
        // held too long: it goes off in hand (explode() handles self-damage)
        this.cooking = null;
        this.nadeEvent = 'cancelled';
        ctx.spawnProjectile && ctx.spawnProjectile({
          type: 'grenade', owner: 'player', pos: this.headPoint(),
          vel: new THREE.Vector3(), damage: 70, splash: 3.6,
          gravity: 0, fuse: 0.01, life: 1,
        });
        return;
      }
    }
    if (!input.isDown('grenade')) this._throwGrenade(ctx);
  }

  _throwGrenade(ctx) {
    const c = this.cooking;
    if (!c) return;
    this.cooking = null;
    this.nadeEvent = 'thrown';
    // spawn no closer to a wall than the head, so the grenade can't start
    // inside a collider and tunnel through it (the head is always in the open)
    const dir = this.lookDir();
    const head = this.headPoint();
    const clear = ctx.physics ? ctx.physics.raycastWorld(head, dir, 0.8) : 0.8;
    const origin = head.addScaledVector(dir, Math.max(0, Math.min(0.6, clear - 0.2)));
    const vel = dir.clone().multiplyScalar(18); vel.y += 3;
    ctx.spawnProjectile && ctx.spawnProjectile({
      type: 'grenade', owner: 'player', pos: origin, vel,
      damage: c.sticky ? 90 : 70, splash: c.sticky ? 3.0 : 3.6, shieldMult: c.sticky ? 2.2 : 1,
      gravity: -16,
      fuse: c.sticky ? 4.0 : Math.max(0.15, c.fuse),
      bounce: c.sticky ? 0 : 0.45,
      sticky: c.sticky,
      life: c.sticky ? 6 : 4,
    });
  }

  _syncCamera(settings, dt) {
    const head = this.headPoint();
    let bob = 0;
    if (settings.data.video.viewBob) bob = Math.sin(this.bobT) * 0.05;
    this.camera.position.set(head.x, head.y + bob, head.z);
    const dir = this.lookDir();
    this.camera.lookAt(head.x + dir.x, head.y + bob + dir.y, head.z + dir.z);
    // ease the FOV toward the ADS target so zoom feels like glass, not a snap
    const adsing = this.weapon && settings._adsActive;
    const fov = settings.data.video.fov / (adsing ? this.weapon.def.adsZoom : 1);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }
  }

  // HUD snapshot
  hudState() {
    const stowed = this.weapons.length > 1 ? this.weapons[(this.current + 1) % this.weapons.length] : null;
    return {
      shield: this.shield, shieldMax: this.shieldMax,
      health: this.health, healthMax: this.healthMax,
      weapon: this.weapon ? this.weapon.name : '—',
      altName: this.weapon && this.weapon.def.alt ? this.weapon.def.alt.name : null,
      stowed: stowed ? stowed.name : null,
      reticle: this.weapon ? this.weapon.def.reticle : 'dot',
      ammo: this.weapon ? this.weapon.ammo : 0,
      reserve: this.weapon ? this.weapon.reserve : 0,
      reloading: this.weapon ? this.weapon.reloading > 0 : false,
      grenades: this.grenades, grenadeType: this.grenadeType,
      // fraction of fuse left on a held grenade (1 for a goober: armed, no burn)
      cook: this.cooking ? (this.cooking.sticky ? 1 : Math.max(0, this.cooking.fuse / this.cooking.max)) : null,
      dmgSfx: this._consumeDmgSfx(), hitFlash: this.lastHitFlash > 0,
      lowShield: this.shield <= 0 && this.health < this.healthMax * 0.5,
    };
  }
  _consumeDmgSfx() { const s = this._dmgSfx; this._dmgSfx = null; return s; }

  // ---- checkpoint serialization ----
  snapshot() {
    // a primed-but-unthrown grenade is still owned: fold it back into the count
    const grenades = { ...this.grenades };
    if (this.cooking) grenades[this.cooking.sticky ? 'goober' : 'frag'] += 1;
    return {
      shield: this.shield, health: this.health, current: this.current, grenadeType: this.grenadeType,
      grenades,
      weapons: this.weapons.map((w) => ({ key: w.key, ammo: w.ammo, reserve: w.reserve })),
    };
  }
  applySnapshot(s) {
    if (!s) return;
    if (typeof s.shield === 'number') this.shield = s.shield;
    if (typeof s.health === 'number') this.health = s.health;
    if (s.grenadeType) this.grenadeType = s.grenadeType;
    if (s.grenades) this.grenades = { ...this.grenades, ...s.grenades };
    if (Array.isArray(s.weapons) && s.weapons.length) {
      this.weapons = s.weapons.map((w) => { const wp = new Weapon(w.key); wp.ammo = w.ammo; wp.reserve = w.reserve; return wp; });
      this.current = Math.min(s.current || 0, this.weapons.length - 1);
    }
  }
}
