// Fx.js — Game methods for combat presentation: tracers, impacts, telegraphs,
// explosions, kill goo, floating damage numbers, slow-mo, the muzzle flash, and
// the first-person view models (weapon / grenade hand / melee fist). Mixed into
// Game.prototype.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';

// Shared FX geometry: goo blobs / impact pips / explosion shells spawn dozens of
// times a second in a big wave — one unit sphere, scaled per mesh, flagged shared
// so the FX reaper doesn't dispose it out from under the next one.
const FX_SPHERE = new THREE.SphereGeometry(1, 8, 6); FX_SPHERE.userData.shared = true;

export const FxMixin = {
  // weapon viewmodel kick + sway — shared by solo/host (_updatePlay) and guest
  _updateViewModel(dt, scoped) {
    if (this._viewModel) {
      this._viewModel.visible = !scoped && !this.player.driving && !this._nadeModel && !this._meleeModel;
      const w = this.player.weapon;
      let dip = 0, roll = 0;
      if (w && w.reloading > 0) {
        const p = Math.max(0, Math.min(1, 1 - w.reloading / w.def.reloadTime));
        const s = Math.sin(p * Math.PI);
        dip = s * 0.22; roll = s * 0.6;
      }
      const target = -0.6 - (this._vmKick || 0);
      this._viewModel.position.z += (target - this._viewModel.position.z) * Math.min(1, dt * 18);
      if (this._vmKick) this._vmKick = Math.max(0, this._vmKick - dt * 0.8);
      const adsing = this.settings._adsActive;
      this._viewModel.position.x += ((adsing ? 0.0 : 0.28) - this._viewModel.position.x) * Math.min(1, dt * 10);
      this._viewModel.position.y += (((adsing ? -0.16 : -0.26) - dip) - this._viewModel.position.y) * Math.min(1, dt * 10);
      this._viewModel.rotation.x += (0 - this._viewModel.rotation.x) * Math.min(1, dt * 10);
      this._viewModel.rotation.z += (roll - this._viewModel.rotation.z) * Math.min(1, dt * 12);
    }
    if (this._muzzleLight.intensity > 0) this._muzzleLight.intensity = Math.max(0, this._muzzleLight.intensity - dt * 200);
  },

  // ---------- FX ----------
  _spawnTracer(a, b) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.fx.push({ mesh: line, life: 0.06, maxLife: 0.06, kind: 'tracer' });
  },

  _spawnImpact(p, kind) {
    const m = new THREE.Mesh(FX_SPHERE, new THREE.MeshBasicMaterial({ color: kind === 'spark' ? 0xffd070 : 0x9cff9c, transparent: true }));
    m.scale.setScalar(0.1);
    m.position.copy(p); this.scene.add(m);
    this.fx.push({ mesh: m, life: 0.18, maxLife: 0.18, kind: 'impact' });
  },

  // A ground danger-ring that brightens as a boss attack winds up, so the player
  // can read and dodge it. Always shown (it's gameplay-critical, not just flair).
  _spawnTelegraph(p, radius, duration, color) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.1, radius - 0.7), radius, 36),
      new THREE.MeshBasicMaterial({ color: color || 0xff5a5a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.06, p.z);
    this.scene.add(ring);
    this.fx.push({ mesh: ring, life: duration, maxLife: duration, kind: 'telegraph' });
  },

  _spawnExplosion(p, r) {
    const m = new THREE.Mesh(FX_SPHERE, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85 }));
    m.scale.setScalar(0.4);
    m.position.copy(p); this.scene.add(m);
    const light = new THREE.PointLight(0xffa040, 3, r * 3); light.position.copy(p); this.scene.add(light);
    this.fx.push({ mesh: m, life: 0.35, maxLife: 0.35, kind: 'boom', r, light });
    this.shakeAmt = Math.max(this.shakeAmt, 0.3);
  },

  _muzzle(def) {
    if (!this._viewModel) return;
    const flash = AssetFactory.muzzleFlash();
    flash.position.set(0, 0.02, -0.55);
    this._viewModel.add(flash);
    this.fx.push({ mesh: flash, life: 0.05, maxLife: 0.05, kind: 'muzzle', parent: this._viewModel });
    this._muzzleLight.intensity = 9; // lights nearby walls; decays in _updatePlay
    this._vmKick = 0.12;
  },

  // First-person grenade hand: raised while cooking (trembling as the fuse
  // burns), an overhand swing on release, an instant drop on cancel.
  _updateNadeModel(dt) {
    const c = this.player.cooking;
    const ev = this.player.nadeEvent;
    this.player.nadeEvent = null;

    // instant drop on cancel / in-hand detonation
    if (ev === 'cancelled') { this._clearNadeModel(); return; }

    if (c) {
      // (re)build when there's no hand yet, the grenade type changed, or a
      // previous throw is still animating out — covers a fast re-prime inside
      // the ~0.2s throw window (otherwise the thrown model would be reused and
      // show the wrong grenade, jerking back into the cook pose)
      if (!this._nadeModel || this._nadeThrowT > 0 || this._nadeSticky !== c.sticky) {
        if (this._nadeModel) this.camera.remove(this._nadeModel);
        this._nadeModel = AssetFactory.grenadeViewModel(c.sticky);
        this._nadeModel.position.set(-0.24, -0.55, -0.5);
        this._nadeModel.rotation.y = Math.PI;
        this.camera.add(this._nadeModel);
        this._nadeSticky = c.sticky;
        this._nadeThrowT = 0;
      }
      const burn = c.sticky ? 0.2 : 1 - c.fuse / c.max;
      this._nadeModel.position.y += (-0.3 - this._nadeModel.position.y) * Math.min(1, dt * 12);
      this._nadeModel.position.x = -0.24 + (Math.random() - 0.5) * 0.022 * burn;
      return;
    }

    // no active cook: play out the overhand throw arc, then drop the hand
    if (!this._nadeModel) return;
    this._nadeThrowT += dt;
    this._nadeModel.position.z -= dt * 3.2;
    this._nadeModel.position.y += (this._nadeThrowT < 0.07 ? dt * 3 : -dt * 5);
    this._nadeModel.rotation.x -= dt * 7;
    if (this._nadeThrowT > 0.2) this._clearNadeModel();
  },

  _clearNadeModel() {
    if (this._nadeModel) { this.camera.remove(this._nadeModel); this._nadeModel = null; }
    this._nadeThrowT = 0;
  },

  // First-person fist: a quick forward jab on melee, then retract and remove.
  _updateMeleeModel(dt) {
    if (this.player.meleeEvent) {
      this.player.meleeEvent = false;
      this._meleeT = 0;
      if (!this._meleeModel) { this._meleeModel = AssetFactory.fistViewModel(); this.camera.add(this._meleeModel); }
    }
    if (!this._meleeModel) return;
    this._meleeT += dt;
    const T = 0.32, p = this._meleeT / T;
    if (p >= 1) { this._clearMeleeModel(); return; }
    const punch = Math.sin(Math.min(1, p) * Math.PI); // 0 → 1 → 0
    this._meleeModel.position.set(0.18 - punch * 0.14, -0.34 + punch * 0.16, -0.32 - punch * 0.46);
    this._meleeModel.rotation.x = -0.35 + punch * 0.35;
    this._meleeModel.rotation.z = (1 - punch) * 0.4;
  },

  _clearMeleeModel() {
    if (this._meleeModel) { this.camera.remove(this._meleeModel); this._meleeModel = null; }
    this._meleeT = 0;
  },

  _setViewModel(key) {
    if (this._vmKey === key) return;
    if (this._viewModel) this.camera.remove(this._viewModel);
    this._vmKey = key;
    if (!key) { this._viewModel = null; return; }
    this._viewModel = AssetFactory.weaponViewModel(key);
    // spawn lowered and tilted; the per-frame lerps raise it (swap feedback)
    this._viewModel.position.set(0.28, -0.62, -0.6);
    this._viewModel.rotation.x = -0.55;
    this._viewModel.rotation.y = Math.PI;
    this._muzzleLight.position.set(0, 0.02, -0.55);
    this._viewModel.add(this._muzzleLight); // re-parents from the old model
    this.camera.add(this._viewModel);
  },

  _maybeDrop() { /* reserved: could drop ammo on kill; kept light for balance */ },

  _updateFX(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const t = Math.max(0, f.life / f.maxLife);
      if (f.kind === 'tracer' || f.kind === 'impact' || f.kind === 'muzzle') { if (f.mesh.material) f.mesh.material.opacity = t; }
      if (f.kind === 'boom') { const s = 0.4 * (1 + (1 - t) * f.r); f.mesh.scale.setScalar(s); f.mesh.material.opacity = t * 0.85; if (f.light) f.light.intensity = 3 * t; }
      if (f.kind === 'telegraph') { if (f.mesh.material) f.mesh.material.opacity = 0.2 + 0.6 * (1 - t); } // brighten toward the hit
      if (f.kind === 'goo') {
        f.vel.y -= 18 * dt;
        f.mesh.position.addScaledVector(f.vel, dt);
        if (f.mesh.position.y < 0.08) { f.mesh.position.y = 0.08; f.vel.set(0, 0, 0); }
        if (f.mesh.material) f.mesh.material.opacity = Math.min(0.9, t * 1.4);
      }
      if (f.life <= 0) {
        if (f.parent) f.parent.remove(f.mesh); else this.scene.remove(f.mesh);
        if (f.light) this.scene.remove(f.light);
        // free the GPU resources (shared/cached geometries are owned by their cache)
        if (f.mesh.geometry && !f.mesh.geometry.userData.shared) f.mesh.geometry.dispose();
        if (f.mesh.material) f.mesh.material.dispose();
        this.fx.splice(i, 1);
      }
    }
    this._updateDamageNumbers(dt);
  },

  // ---- combat juice ----------------------------------------------------------
  _onEnemyKilled(e) {
    this.hud.killFeed(e.meta.name, e.meta.scoreColor);
    if (this._daily && this._daily.mode === 'mission') this._dailyKills++;   // mission-of-the-day scoring
    this._spawnGoo(e.pos, e.meta.scoreColor);
    if (this.player && this.player.healOnKill && !this.player.dead && !e._noSiphon) this.player.addHealth(this.player.healOnKill); // perk: Goo Siphon (earned kills only)
    if (this.enemies.filter((x) => !x.dead).length === 0) this._triggerSlowmo(); // screen-clearing kill
  },

  _triggerSlowmo() {
    if (this._reducedMotion || this._slowmoCd > 0) return;
    this._slowmoT = 0.55; this._slowmoCd = 3.0;
  },

  _spawnGoo(pos, color) {
    if (this._reducedMotion) return;
    const c = color || 0x9cff9c;
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(FX_SPHERE, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }));
      m.scale.setScalar(0.08 + Math.random() * 0.1);
      m.position.set(pos.x, pos.y + 1.0, pos.z);
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4.5;
      const vel = new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 3.5, Math.sin(a) * sp);
      this.fx.push({ mesh: m, life: 0.55 + Math.random() * 0.35, maxLife: 0.9, kind: 'goo', vel });
    }
  },

  _spawnDamageNumber(worldPos, amount, crit) {
    if (this._reducedMotion) return;
    const el = document.createElement('div');
    el.className = 'dmgnum' + (crit ? ' crit' : '');
    el.textContent = Math.max(1, Math.round(amount)) + (crit ? '!' : '');
    this._numLayer.appendChild(el);
    this._dmgNums.push({ el, pos: worldPos.clone(), life: 0.8, maxLife: 0.8, vy: 1.6 + Math.random() * 0.6, dx: (Math.random() - 0.5) * 18 });
    if (this._dmgNums.length > 40) { const old = this._dmgNums.shift(); old.el.remove(); }
  },

  _updateDamageNumbers(dt) {
    if (!this._dmgNums.length) return;
    const v = new THREE.Vector3();
    for (let i = this._dmgNums.length - 1; i >= 0; i--) {
      const n = this._dmgNums[i];
      n.life -= dt;
      if (n.life <= 0) { n.el.remove(); this._dmgNums.splice(i, 1); continue; }
      n.pos.y += n.vy * dt;                                  // float up in world space
      v.copy(n.pos).project(this.camera);
      if (v.z > 1) { n.el.style.opacity = '0'; continue; }   // behind the camera
      const x = (v.x * 0.5 + 0.5) * window.innerWidth + n.dx * (1 - n.life / n.maxLife);
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      n.el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
      n.el.style.opacity = String(Math.min(1, (n.life / n.maxLife) * 1.6));
    }
  },
};
