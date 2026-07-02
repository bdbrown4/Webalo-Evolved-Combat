// RemotePlayers.js — Game methods for everything shared by the multiplayer modes:
// remote player bodies + buddy avatars, the connection overlay, the guest-side
// frame loop (predict own movement, render the rest from snapshots), and the
// guest HUD. Mixed into Game.prototype (state lives on the Game instance).

import * as THREE from 'three';
import { Player } from '../entities/Player.js';
import { applyPerk } from '../core/Perks.js';
import { serializeInput, interpolateGhosts, interpPvp, NET_INPUT_DT } from '../net/CoopSync.js';

export const RemotePlayersMixin = {
  // ---------- co-op: remote players ----------
  _coopDummy() { try { return new URLSearchParams(location.search).get('coopdummy') === '1'; } catch (e) { return false; } },

  // A second (or third…) player that this client does not control directly: on the
  // host it's the guest driven by networked input; the dev dummy wanders on its own.
  // It's a full Player (so enemies/projectiles damage it through the same paths) but
  // owns a throwaway camera so it never touches our real view, and carries a visible
  // "buddy" avatar (the local player stays first-person/invisible).
  addRemotePlayer(spawn, opts = {}) {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
    const p = new Player(cam, spawn);
    p.remote = true;
    p.netId = opts.id || 'guest';
    p.dmgTakenMult = this._diff ? this._diff.dmgTaken : 1;
    (opts.weapons || ['rifle', 'pistol']).forEach((w) => p.giveWeapon(w));
    // co-op campaign: the guest carries its own run perks (host-authoritative, so the
    // host applies them to the simulated guest player and tops it up to the new maxes)
    (opts.perks || []).forEach((id) => applyPerk(p, id));
    p.shield = p.shieldMax; p.health = p.healthMax;
    p._avatar = this._makeBuddyAvatar(opts.color);
    p._avatar.position.copy(p.pos);
    this.scene.add(p._avatar);
    this.players.push(p);
    return p;
  },

  _makeBuddyAvatar(color) {
    const g = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color: color || 0x3d7bd6, metalness: 0.3, roughness: 0.6 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.7, 4, 10), armor);
    torso.position.y = 1.0; torso.castShadow = true; g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), armor);
    head.position.y = 1.62; head.castShadow = true; g.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.09),
      new THREE.MeshStandardMaterial({ color: 0x8ffcff, emissive: 0x2bd6ff, emissiveIntensity: 0.8, metalness: 0.4, roughness: 0.3 }));
    visor.position.set(0, 1.64, 0.22); g.add(visor);
    // a stubby rifle nub pointing +Z (forward at yaw 0) so the buddy's facing reads
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.6, roughness: 0.4 }));
    gun.position.set(0.26, 1.0, 0.34); g.add(gun);
    return g;
  },

  // Advance a non-local player. The dev dummy ambles in a slow circle; the networked
  // guest (Slice 3) will instead be driven from forwarded input. Either way we keep
  // its shields/weapons ticking and sync its avatar to its transform.
  _updateRemotePlayer(rp, dt, ctx) {
    if (!rp.dead && rp._dummy) {
      rp._wanderT = (rp._wanderT || 0) + dt;
      rp.yaw = rp._wanderT * 0.6;
      const fwd = new THREE.Vector3(Math.sin(rp.yaw), 0, Math.cos(rp.yaw));
      rp.vel.x = fwd.x * 2.5; rp.vel.z = fwd.z * 2.5;
      rp.vel.y += ctx.physics.gravity * dt;
      const res = ctx.physics.moveAndCollide(rp.pos, rp.vel, dt, rp.radius, rp.curHeight);
      if (res.grounded && rp.vel.y < 0) rp.vel.y = 0;
      rp._regen(dt, ctx);
      if (rp.weapon) rp.weapon.update(dt);
    } else if (!rp.dead && rp._netInput) {
      // Networked guest: trust the latest packet's transform, then run combat-only
      // (Player.update remote branch) so the host resolves the guest's shots/etc.
      const pkt = rp._netInput.latest;
      // a co-op gunner rides the vehicle — its position is owned by the Vehicle, not
      // its reported transform — so only take its look (drives the turret aim).
      if (pkt) { if (!rp._gunner) rp.pos.set(pkt.x, pkt.y, pkt.z); rp.yaw = pkt.yaw; rp.pitch = pkt.pitch; if (pkt.h) rp.curHeight = pkt.h; }
      rp._netInput.beginFrame();
      rp.update(dt, rp._netInput, this.settings, ctx);
    }
    this._syncAvatar(rp);
  },

  _syncAvatar(rp) {
    if (!rp._avatar) return;
    rp._avatar.visible = !rp.dead;
    rp._avatar.position.set(rp.pos.x, rp.pos.y, rp.pos.z);
    rp._avatar.rotation.y = rp.yaw;
  },

  // ---------- co-op: session start ----------
  // queue a one-shot event for the next snapshot (no-op unless we're the host)
  _netPush(k, ...d) { if (this.coopRole === 'host') this._netEvents.push([k, ...d]); },

  // This room already has its players — tell the late joiner and offer the exit.
  _coopFullNotice() {
    if (this.level) return;                      // already playing — not us (defensive)
    this._coopClearTimers();
    const net = this.net; this.net = null; this.coopRole = null;
    if (net) { try { net.close(); } catch (e) { /* gone */ } }
    if (this._pendingNet) { try { this._pendingNet.close(); } catch (e) { /* gone */ } this._pendingNet = null; }
    const el = this._showCoopOverlay(`
      <div class="coop-title">Session Full</div>
      <div class="coop-sub" style="text-align:center">That room already has its players. Ask the host for a fresh code, or start your own.</div>
      <button class="btn ghost" data-act="back">← Back</button>`);
    el.querySelector('[data-act="back"]').addEventListener('click', () => { this._clearCoopOverlay(); this.onQuit && this.onQuit(); });
  },

  // ---------- co-op: lobby / connection ----------
  _showCoopOverlay(html) {
    this._clearCoopOverlay();
    const el = document.createElement('div');
    el.className = 'interactive coop-overlay';
    el.innerHTML = `<div class="screen"><div class="coop-panel">${html}</div></div>`;
    this.root.appendChild(el);
    this._coopOverlayEl = el;
    return el;
  },

  _clearCoopOverlay() { this._coopClearTimers(); if (this._coopOverlayEl) { this._coopOverlayEl.remove(); this._coopOverlayEl = null; } },

  _coopCancel(net) { try { net && net.close(); } catch (e) { /* gone */ } this._pendingNet = null; this._clearCoopOverlay(); this.onQuit && this.onQuit(); },

  _coopSetStatus(el, text, ok) {
    const st = el && el.querySelector('.coop-status'); if (st) st.textContent = text;
    if (ok) { const sp = el.querySelector('.coop-spinner'); if (sp) sp.classList.add('coop-spinner-ok'); }
  },

  _coopFail(el, net, msg) {
    try { net.close(); } catch (e) { /* gone */ }
    this._pendingNet = null; this._coopClearTimers();
    const panel = el.querySelector('.coop-panel');
    panel.innerHTML = `
      <div class="coop-title">Couldn’t connect</div>
      <div class="coop-sub">${msg}</div>
      <button class="btn ghost" data-act="back">← Back</button>`;
    panel.querySelector('[data-act="back"]').addEventListener('click', () => { this._clearCoopOverlay(); this.onQuit && this.onQuit(); });
  },

  _coopClearTimers() {
    clearTimeout(this._coopReassure); clearTimeout(this._coopFailTimer); clearTimeout(this._coopLaunchTimer);
    this._coopReassure = this._coopFailTimer = this._coopLaunchTimer = null;
  },

  // A peer's transport dropped. Tell whoever's left and offer the exit.
  _onPeerLeft() {
    if (!this.coopRole || this._coopLeft) return;
    this._coopLeft = true;
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    if (this._svHudEl) this._svHudEl.style.display = 'none';
    if (this._pvpHud) this._pvpHud.style.display = 'none';
    this._clearCoopHud();
    const el = this._showCoopOverlay(`
      <div class="coop-title">${this._pvp ? 'Rival' : 'Partner'} Disconnected</div>
      <div class="coop-sub" style="text-align:center">${this._pvp ? 'Everyone left the match.' : 'Your co-op partner left the session.'}</div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  },

  // GUEST update: predict our own movement/aim locally, forward input to the host,
  // and render the rest of the world (enemy/projectile ghosts, host avatar) from
  // the latest snapshot. No AI, no authoritative damage — the host owns all that.
  _updateGuest(dt) {
    this._netClock = (this._netClock || 0) + dt;   // monotonic clock for snapshot interpolation
    if (this.isTouch && this.touch) { const fire = this.touch.fireHeld || this.touch.tapFire; this.touch.tapFire = false; this.input.setVirtual('fire', fire); }
    this.input.beginFrame();
    const ctx = this._ctx();
    // as a turret gunner, Fire/ADS work the turret — never our handheld scope/ADS.
    const gunner = this._guestGunner && this._vehGhost;
    this.settings._adsActive = !gunner && this.input.isDown('ads') && this.player.weapon != null;
    const scoped = !gunner && !!(this.settings._adsActive && this.player.weapon && this.player.weapon.def.scoped);
    if (scoped !== this._scoped) { this._scoped = scoped; this.audio.sfx(scoped ? 'scopein' : 'scopeout'); }

    interpolateGhosts(this, dt);   // update ghost/host-avatar/vehicle positions before we ride them
    if (this._pvp) { interpPvp(this, dt); this._pvpAnimatePads(dt); }   // avatars + pads
    // PvP: the host owns our life. While dead we freeze (respawn overlay); on the
    // dead→alive edge we snap to our spawn (the host has already moved us there).
    const pvpDead = !!(this._pvp && this._pvpMe && this._pvpMe.dead);
    if (this._pvp && this._wasPvpDead && !pvpDead && this._mySpawn) { this.player.pos.copy(this._mySpawn); this.player.vel.set(0, 0, 0); this.player.yaw = this._mySpawn.yaw || 0; this.input.clearTransient(); }
    this._wasPvpDead = pvpDead;
    if (gunner) {
      // turret seat: position comes from the host's synced transform (the vehicle
      // ghost); we just free-look to aim and forward Fire — the host's turret shoots.
      this.player.driving = true;
      this.player._look(this.input, this.settings);
      this.player.pos.copy(this._vehGhost.mesh.position);
      this.player._syncCamera(this.settings, dt);
    } else if (pvpDead) {
      this.player._look(this.input, this.settings);   // spectate-look while dead, no move
      this.player._syncCamera(this.settings, dt);
    } else {
      this.player.driving = false;
      this.player.updateGuest(dt, this.input, this.settings, ctx);
    }
    // gunner: no handheld view-model (the turret is the weapon) — clearing it on the
    // mount frame avoids a one-frame flash of the rifle before the seat takes over.
    this._setViewModel(gunner ? null : (this.player.weapon ? this.player.weapon.key : null));
    if (!gunner) this._guestFireCosmetic(dt);
    this._updateViewModel(dt, scoped);

    this._netInputAccum += dt;
    if (this._netInputAccum >= NET_INPUT_DT && this.net) {
      this._netInputAccum = 0;
      this.net.send('input', serializeInput(this.player, this.input, this.touch, ++this._netSeq));
    }

    this._updateGuestHud(dt, scoped);
    if (this._pvp) this._updatePvpHud(); else this._updateCoopHud();
    if (this.aureole) this.aureole.rotation.z += dt * 0.01;
    this.input.endFrame();
  },

  // Local-only fire feedback for the guest (muzzle flash + sfx). Damage and ammo
  // are the host's; we just make pulling the trigger feel alive. Gated by the
  // host-reported ammo so an empty mag stays quiet.
  _guestFireCosmetic(dt) {
    if (this._guestFireCd > 0) this._guestFireCd -= dt;
    const w = this.player.weapon; if (!w) return;
    const def = w.def;
    const gp = this._guestNetState;
    if (gp && gp.ammo <= 0) return;
    const alt = this.input.isDown('ads') && def.alt;
    const wantFire = def.auto ? this.input.isDown('fire') : this.input.pressed('fire');
    if (wantFire && this._guestFireCd <= 0) {
      this._guestFireCd = 1 / ((alt ? def.alt.fireRate : def.fireRate) || 4);
      this.audio.sfx((alt && def.alt.sfx) ? def.alt.sfx : def.sfx);
      this._muzzle(def);
      this.player.justFired = 0.06;
    }
  },

  // GUEST: the host owns our vitals, so "being shot" only shows up as the snapshot's
  // health/shield dropping — turn that drop back into the flash + hurt/shield sfx a
  // local hit would have made. Regen/revive RAISE vitals, so rises never trigger it.
  _guestDamageFeedback(health, shield) {
    const prev = this._lastGuestVitals;
    this._lastGuestVitals = { h: health, s: shield };
    if (!prev) return false;
    const drop = (prev.h - health) + (prev.s - shield);
    if (drop < 0.5) return false;
    this.audio.sfx(prev.s > 0 && shield <= 0 ? 'shieldbreak' : shield > 0 ? 'shieldhit' : 'hurt');
    if (this.settings.data.gameplay && this.settings.data.gameplay.haptics) {
      this.input.rumble(0.5, 130);
      if (this.isTouch && navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
    }
    return true;   // caller sets hs.hitFlash for this frame
  },

  _updateGuestHud(dt, scoped) {
    const gp = this._guestNetState;
    let hs;
    if (this._pvp && this._pvpMe) {
      // Deathmatch: our authoritative state (health/ammo/weapon) comes from the host
      // via the all-players snapshot; grenades are cosmetic-local.
      const me = this._pvpMe;
      hs = {
        shield: me.shield, shieldMax: this.player.shieldMax, health: me.health, healthMax: this.player.healthMax,
        weapon: me.weapon, altName: null, stowed: null, reticle: me.reticle,
        ammo: me.ammo, reserve: me.reserve, reloading: me.reloading,
        grenades: this.player.grenades, grenadeType: this.player.grenadeType, cook: null,
        dmgSfx: null, hitFlash: false, lowShield: me.shield <= 0 && me.health < this.player.healthMax * 0.5,
        scoped, scopeZoom: scoped && this.player.weapon ? this.player.weapon.def.adsZoom : 0, driving: false,
      };
    } else if (this._guestGunner) {
      // turret gunner: an IRIS readout (unlimited, no reload) in place of the
      // suppressed handheld weapon; the centred crosshair is the turret's aim. Keyed
      // off _guestGunner alone so the label flips to IRIS the instant we mount.
      hs = {
        shield: gp ? gp.shield : this.player.shield, shieldMax: gp ? gp.shieldMax : this.player.shieldMax,
        health: gp ? gp.health : this.player.health, healthMax: gp ? gp.healthMax : this.player.healthMax,
        weapon: 'IRIS TURRET', altName: null, stowed: null, reticle: 'dot',
        ammo: '∞', reserve: '', reloading: false, noReserve: true,
        grenades: gp ? gp.grenades : { frag: 0, goober: 0 }, grenadeType: gp ? gp.grenadeType : 'frag', cook: null,
        dmgSfx: null, hitFlash: false, lowShield: false, scoped: false, scopeZoom: 0, driving: false,
      };
    } else hs = gp ? {
      shield: gp.shield, shieldMax: gp.shieldMax, health: gp.health, healthMax: gp.healthMax,
      weapon: gp.weapon, altName: gp.altName, stowed: null, reticle: gp.reticle,
      ammo: gp.ammo, reserve: gp.reserve, reloading: gp.reloading,
      grenades: gp.grenades, grenadeType: gp.grenadeType, cook: gp.cook,
      dmgSfx: null, hitFlash: false, lowShield: gp.shield <= 0 && gp.health < gp.healthMax * 0.5,
      scoped, scopeZoom: scoped && this.player.weapon ? this.player.weapon.def.adsZoom : 0, driving: false,
    } : this.player.hudState();
    // vitals drop → flash + sfx (the host owns damage; we reconstruct the feel)
    if (this._pvp && this._pvpMe) hs.hitFlash = this._guestDamageFeedback(this._pvpMe.health, this._pvpMe.shield) || hs.hitFlash;
    else if (gp) hs.hitFlash = this._guestDamageFeedback(gp.health, gp.shield) || hs.hitFlash;
    const ghostEnemies = [];
    for (const [, g] of this._ghosts) if (!g.dead) ghostEnemies.push({ pos: g.mesh.position });
    this.hud.update(dt, hs, ghostEnemies, this.player);
    if (this._svHudEl && this._svNetState) {
      const s = this._svNetState;
      this._svHudEl.querySelector('.sv-wave').textContent = 'WAVE ' + (s[0] || '—');
      this._svHudEl.querySelector('.sv-score').textContent = 'SCORE ' + s[1];
      this._svHudEl.querySelector('.sv-foe').textContent = s[2] === 'fighting' ? s[3] + ' left' : s[2] === 'breather' ? 'next wave…' : '';
    }
  },
};
