// CoopSession.js — Game methods for 2-player co-op (Survival + full campaign):
// session start on both sides, host-authoritative downs/revives, the shared
// mission flow (per-player perk picks, host-led advance), the down/revive HUD,
// and the vehicle gunner seat. Mixed into Game.prototype.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';
import { Survival, SURVIVAL_MISSION } from '../ui/Survival.js';
import { CAMPAIGN } from '../missions/campaign.js';
import { PERKS, PERK_IDS } from '../core/Perks.js';
import { COOP } from '../entities/Player.js';
import { serializeSnapshot, applySnapshot, NetInputProxy } from '../net/CoopSync.js';
import { hostTrystero, joinTrystero, createManual, makeRoomCode } from '../net/Net.js';

export const CoopSessionMixin = {
  // HOST: called once the guest's transport connects. Wires the one-time net handlers,
  // then builds the first mission (Survival arena, or campaign mission 0). Subsequent
  // rebuilds — shared retries and campaign advances — go straight to _coopBuildMission.
  startCoopHost(net) {
    this.net = net; this.coopRole = 'host';
    this._coopOver = false; this._coopLeft = false;
    this._runPerks = []; this._guestRunPerks = []; this._pendingGuestPerk = null; this._hostPendingPerk = null;
    this.missionIndex = 0; this._lastEscPush = null;
    // co-op is exactly TWO players. Bind to the first peer; if anyone else wanders
    // into the room code, ignore their input and tell them the session is full
    // (without this, a 3rd player's inputs would merge into the one guest body).
    this._coopPeerId = net.peers()[0] || null;
    net.onPeer((id) => {
      if (this._coopPeerId == null) this._coopPeerId = id;
      else if (id !== this._coopPeerId) net.send('full', 1, id);
    });
    net.on('input', (pkt, peerId) => {
      if (peerId !== undefined && this._coopPeerId !== null && peerId !== this._coopPeerId) return;
      if (this._guestPlayer && this._guestPlayer._netInput) this._guestPlayer._netInput.feed(pkt);
    });
    net.on('retryReq', () => { if (this._coopOver) this._coopRetry(); });
    net.on('guestPerk', (id) => { this._pendingGuestPerk = id; });        // campaign: guest's between-mission pick
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
    this._coopBuildMission();
  },

  // HOST: build (or rebuild) the CURRENT co-op mission under a fresh shared seed, drop
  // the guest in beside us, and ship 'start' so the guest builds the matching world.
  // Reused for the initial launch, a shared retry, and a campaign mission advance.
  _coopBuildMission() {
    this._coopOver = false; this._coopLeft = false; this._lastEscPush = null;
    this._levelSeed = (Date.now() & 0x7fffffff) || 1;
    this._resume = false;
    this._setRunMods([]); this._daily = null;       // co-op runs aren't mutated/daily

    const campaign = this._coopMode === 'campaign';
    if (campaign) {
      this._beginMission(CAMPAIGN[this.missionIndex]);             // win/advance handled by the level
    } else {
      this.missionIndex = 0; this._runPerks = [];
      this._beginMission(SURVIVAL_MISSION);
      this.level.freeplay = true;
    }
    const gs = this.player.pos.clone(); gs.x += 4;                 // guest spawns beside the host
    // arm the simulated guest with the mission's loadout so the host resolves the
    // guest's shots with the SAME weapon the guest sees locally (campaign loadouts vary)
    const guestWeapons = campaign ? CAMPAIGN[this.missionIndex].startWeapons.slice() : ['rifle', 'pistol'];
    const guest = this.addRemotePlayer(gs, { color: 0xffb454, id: 'guest', weapons: guestWeapons, perks: campaign ? this._guestRunPerks : [] });
    guest._netInput = new NetInputProxy();
    this._guestPlayer = guest;
    this.player.downable = true; guest.downable = true;            // co-op: 0 HP downs, doesn't kill
    this.net.send('start', { seed: this._levelSeed, gs: { x: gs.x, y: gs.y, z: gs.z }, mode: this._coopMode, mi: this.missionIndex, gPerks: this._guestRunPerks });
    if (!campaign) { this.survival = new Survival(this.root, this, () => this.quitToMenu()); this.survival.start(); }
  },

  // GUEST: register handlers as soon as we join; the world is built when the host's
  // 'start' arrives (so we use its seed), then snapshots drive everything.
  joinCoop(net) {
    this.net = net; this.coopRole = 'guest';
    this._coopOver = false; this._coopLeft = false;
    net.on('start', (d) => this._beginCoopGuest(d));
    net.on('snap', (snap) => { this._lastSnap = snap; applySnapshot(this, snap); });
    net.on('full', () => this._coopFullNotice());
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
  },

  _beginCoopGuest(d) {
    // each 'start' (re)builds the world — initial join, co-op retries, AND campaign
    // mission advances all arrive here, carrying the host's mode/seed/mission index.
    this._netClock = 0;
    this._levelSeed = d.seed;
    this._coopMode = d.mode || 'survival';
    this._resume = false; this._runPerks = [];
    this._setRunMods([]); this._daily = null;
    const campaign = this._coopMode === 'campaign';
    this.missionIndex = campaign ? (d.mi || 0) : 0;
    this._guestRunPerks = d.gPerks || [];                          // mirrors the host's view of our perks
    this._beginMission(campaign ? CAMPAIGN[this.missionIndex] : SURVIVAL_MISSION);
    if (!campaign) this.level.freeplay = true;
    if (d.gs) { this.player.pos.set(d.gs.x, d.gs.y, d.gs.z); this.player._syncCamera(this.settings, 0); }
    this._hostAvatar = this._makeBuddyAvatar(0x3d7bd6);            // the host, drawn from snapshots
    this.scene.add(this._hostAvatar);
    if (!campaign) this._initGuestSurvivalHud();
    this._clearCoopOverlay();
    this._clearResult();                                          // drop any lingering mission-complete screen
  },

  // HOST over Trystero relays: show a room code, wait for the guest, then begin.
  coopHost(mode) {
    this._coopMode = mode || 'survival';
    const where = this._coopMode === 'campaign' ? 'New Campaign' : 'Survival';
    const code = makeRoomCode();
    const net = hostTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Hosting ${this._coopMode === 'campaign' ? 'Campaign' : 'Survival'} Co-op</div>
      <div class="coop-sub">Send this code to your friend — they open <b>${where}</b> and pick <b>Join</b>:</div>
      <div class="coop-code">${code}</div>
      <button class="btn" data-act="copy">⧉ Copy Code</button>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Waiting for a friend to join…</span></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    const copyBtn = el.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy Code'; }, 1200); } catch (e) {} });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    net.onState((s) => {
      if (s === 'connected' && this.coopRole !== 'host') {
        this._coopSetStatus(el, 'Friend connected! Launching…', true);
        this._coopLaunchTimer = setTimeout(() => { this._pendingNet = null; this._clearCoopOverlay(); this.startCoopHost(net); }, 700);
      }
    });
  },

  // JOIN over Trystero relays: enter the host's code, connect, wait for 'start'.
  // The authoritative mode comes from the host's 'start' packet; this is just a hint.
  coopJoin(code, mode) {
    this._coopMode = mode || 'survival';
    const net = joinTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Joining ${code}</div>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Reaching your friend…</span></div>
      <div class="coop-dim">Peer-to-peer can take a few seconds to link up.</div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    this.joinCoop(net);
    // reassure after a beat, fail clearly if it never links up
    this._coopReassure = setTimeout(() => this._coopSetStatus(el, 'Still linking… hang tight (relays can be slow).'), 5000);
    this._coopFailTimer = setTimeout(() => { if (!this.level) this._coopFail(el, net, 'Couldn’t reach the host. Double-check the code and that they’re still hosting — or try Manual connect.'); }, 25000);
    net.onState((s) => { if (s === 'connected') this._coopSetStatus(el, 'Connected! Starting…', true); });
  },

  // ---------- co-op: downs / revives (host-authoritative) ----------
  _isReviving(r) {
    if (r === this.player) return this.input.isDown('interact');
    if (r._netInput) return r._netInput.isDown('interact');
    return false;
  },

  // Co-op campaign: progress is gated on squad cohesion — while ANY squadmate is
  // down, the room won't clear/advance (the standing player must revive them).
  // Solo, survival, and PvP never hold.
  _coopSquadHeld() {
    if (this.coopRole !== 'host' || this._pvp || this._coopMode !== 'campaign') return false;
    // Gate on `downed` only: a downed mate is revivable, so holding here always has an
    // exit. (Campaign players don't bleed out to `dead` — see _updateDownsAndRevives —
    // so this never wedges on an unrevivable body.)
    for (const p of this.players) if (p && p.downed) return true;
    return false;
  },

  _updateDownsAndRevives(dt, ctx) {
    const campaign = this._coopMode === 'campaign';
    let anyUp = false;
    for (const p of this.players) {
      if (!p.dead && !p.downed) { anyUp = true; continue; }
      if (!p.downed) continue;
      if (!campaign) {                                  // survival: bleed out if no one reaches them
        p.bleedT -= dt;
        if (p.bleedT <= 0) { p.downed = false; p.dead = true; p.reviveProg = 0; continue; }
      }
      // Campaign: a downed player never bleeds out to permanent death while a
      // teammate still stands — they wait to be revived (progress is held meanwhile).
      // Both going down still ends the run via _coopAllDown below.
      let reviving = false;                             // a standing teammate, in range, holding Interact
      for (const r of this.players) {
        if (r === p || r.dead || r.downed) continue;
        if (r.pos.distanceTo(p.pos) <= COOP.REVIVE_RANGE && this._isReviving(r)) { reviving = true; break; }
      }
      if (reviving) {
        p.reviveProg = Math.min(1, p.reviveProg + dt / COOP.REVIVE_TIME);
        if (p.reviveProg >= 1) {
          p.revive();
          this.audio.sfx('shieldrecharge'); this._netPush('sfx', 'shieldrecharge');
          this.hud.banner('REVIVED', 'Back in the fight!', 1.4); this._netPush('banner', 'REVIVED', 'Back in the fight!', 1.4);
        }
      } else {
        p.reviveProg = Math.max(0, p.reviveProg - dt * 0.5);   // bleed the progress back off
      }
    }
    if (!anyUp && !this._coopOver) this._coopAllDown();
  },

  _coopAllDown() {
    if (this._coopOver) return;
    this._coopOver = true;
    if (this._coopMode === 'campaign') {                            // both fell mid-mission → shared retry
      this._netPush('coopfail');
      if (this.net) this.net.send('snap', serializeSnapshot(this));
      this._showCoopFail(true);
      return;
    }
    const wave = this.survival ? this.survival.wave : 0;
    const score = this.survival ? this.survival.score : 0;
    if (this.survival) this.survival.recordBest();
    this._netPush('coopover', wave, score);
    if (this.net) this.net.send('snap', serializeSnapshot(this));   // flush the event to the guest now
    this._showCoopOver(wave, score, true);
  },

  // Shared co-op game-over — shown on BOTH peers (guest gets it via the 'coopover'
  // event). The session STAYS connected: Retry re-runs together with no re-handshake.
  _showCoopOver(wave, score) {
    this.audio.sfx('lose');
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    if (this._svHudEl) this._svHudEl.style.display = 'none';
    this._clearCoopHud();
    const el = this._showCoopOverlay(`
      <div class="coop-title">You Both Fell</div>
      <div class="coop-sub" style="text-align:center">Wave <b>${wave}</b> · Score <b>${score}</b> — still linked up.</div>
      <button class="btn primary" data-act="retry">↻ Retry Together</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="retry"]').addEventListener('click', () => this._coopRetry(el));
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  },

  // Retry from the shared lobby. Host-authoritative: the host rebuilds (fresh seed,
  // both players respawned) and re-sends 'start'; the guest just asks the host to.
  _coopRetry(el) {
    if (this.coopRole === 'host') {
      if (!this._coopOver) return;                 // only valid from the game-over lobby
      this._clearCoopOverlay();
      this._coopBuildMission();                    // rebuild the current mission → guest rebuilds
    } else {
      if (this.net) this.net.send('retryReq', 1);
      this._coopSetStatus(el, 'Asking the host to restart…');
    }
  },

  // ---------- co-op: down/revive HUD (works for host + guest) ----------
  _ensureCoopHud() {
    if (this._coopHud) return;
    const wrap = document.createElement('div');
    wrap.className = 'coop-hud';
    wrap.innerHTML = '<div class="coop-vignette"></div><div class="coop-downmsg"></div><div class="coop-alert"></div><div class="coop-marker"></div><div class="coop-name"></div><div class="coop-arrow"></div>';
    this.root.appendChild(wrap);
    this._coopHud = wrap;
    this._coopVignette = wrap.querySelector('.coop-vignette');
    this._coopDownMsg = wrap.querySelector('.coop-downmsg');
    this._coopAlert = wrap.querySelector('.coop-alert');
    this._coopMarker = wrap.querySelector('.coop-marker');
    this._coopName = wrap.querySelector('.coop-name');
    this._coopArrow = wrap.querySelector('.coop-arrow');
  },

  _clearCoopHud() {
    if (this._coopHud) { this._coopHud.remove(); this._coopHud = null; this._coopVignette = this._coopDownMsg = this._coopAlert = this._coopMarker = this._coopName = this._coopArrow = null; }
  },

  _updateCoopHud() {
    if (!this.coopRole || this.state !== 'playing') { this._clearCoopHud(); return; }
    // during the vehicle escape both ride the transport (invulnerable, co-located) —
    // the down/revive markers are moot and would just clutter screen-centre.
    if (this.vehicle || this._guestGunner) { this._clearCoopHud(); return; }
    this._ensureCoopHud();
    // resolve my own + my partner's down state, whichever side we're on
    let meDowned = false, meDead = false, meBleed = 0, meRevive = 0;
    let pPos = null, pDowned = false, pRevive = 0, pBleed = 0, pDead = false, pHealthFrac = 1;
    if (this.coopRole === 'host') {
      const me = this.player, partner = this._guestPlayer;
      meDowned = me.downed; meDead = me.dead; meBleed = me.bleedT; meRevive = me.reviveProg;
      if (partner) { pPos = partner.pos; pDowned = partner.downed; pRevive = partner.reviveProg; pBleed = partner.bleedT; pDead = partner.dead; pHealthFrac = partner.health / partner.healthMax; }
    } else {
      const gp = this._guestNetState || {};
      meDowned = !!gp.downed; meDead = !!gp.dead; meBleed = gp.bleedT || 0; meRevive = gp.reviveProg || 0;
      const hs = this._hostState;
      if (hs && this._hostAvatar) { pPos = this._hostAvatar.position; pDowned = hs.st === 1; pRevive = hs.reviveProg || 0; pBleed = hs.bleedT || 0; pDead = hs.st === 2; pHealthFrac = (hs.health || 0) / 45; }
    }
    // MY down state: red vignette + centre message
    this._coopVignette.style.opacity = meDowned ? '1' : '0';
    if (meDowned) {
      this._coopDownMsg.style.display = 'block';
      // Campaign: no bleed-out clock — you wait (the run only ends if both fall), so
      // show the squad-revive line instead of a countdown. Survival keeps the timer.
      const downSub = this._coopMode === 'campaign'
        ? `<div class="cd-sub">Hold on — your squad must revive you</div>`
        : `<div class="cd-sub">Hold on — a teammate can revive you</div><div class="cd-timer">${Math.ceil(meBleed)}s</div>`;
      this._coopDownMsg.innerHTML = meRevive > 0.02
        ? `<div class="cd-big">BEING REVIVED…</div><div class="cd-bar"><i style="width:${Math.round(meRevive * 100)}%"></i></div>`
        : `<div class="cd-big">YOU'RE DOWN</div>${downSub}`;
    } else { this._coopDownMsg.style.display = 'none'; }
    // PARTNER: nameplate when up & on-screen; revive marker when downed & on-screen;
    // an edge arrow toward a DOWNED partner who's off-screen; a top alert when downed.
    const W = window.innerWidth, H = window.innerHeight;
    let aAlert = false, aMarker = false, aName = false, aArrow = false;
    if (pPos && !pDead && !meDowned && !meDead) {
      const key = this._ctrlKey('interact', 'USE');
      const dist = this.player.pos.distanceTo(pPos);
      const inRange = dist <= COOP.REVIVE_RANGE;
      const v = new THREE.Vector3(pPos.x, pPos.y + 1.85, pPos.z).project(this.camera);
      const behind = v.z > 1;
      const onScreen = !behind && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95;
      if (onScreen) {
        const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        if (pDowned) {
          aMarker = true;
          this._coopMarker.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
          this._coopMarker.innerHTML = inRange
            ? `<div class="cm-pip rev">＋</div><div class="cm-lbl">${key} · ${Math.round(pRevive * 100)}%</div>`
            : `<div class="cm-pip">▾</div><div class="cm-lbl">${Math.round(dist)}m · ${Math.ceil(pBleed)}s</div>`;
        } else {
          aName = true;
          this._coopName.style.transform = `translate(-50%,-100%) translate(${x}px,${y - 6}px)`;
          this._coopName.innerHTML = `<span class="cn-tag">ALLY</span><span class="cn-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, pHealthFrac)) * 100)}%"></i></span>`;
        }
      } else if (pDowned) {
        aArrow = true;
        let dx = v.x, dy = v.y; if (behind) { dx = -dx; dy = -dy; }
        const ang = Math.atan2(dy, dx);
        const ex = Math.cos(ang), ey = Math.sin(ang);
        const sc = Math.min((W / 2 - 56) / Math.max(1e-3, Math.abs(ex)), (H / 2 - 56) / Math.max(1e-3, Math.abs(ey)));
        const px = W / 2 + ex * sc, py = H / 2 - ey * sc;
        this._coopArrow.style.transform = `translate(-50%,-50%) translate(${px}px,${py}px)`;
        this._coopArrow.innerHTML = `<span class="ca-chev" style="transform:rotate(${-ang}rad)">➤</span><span class="ca-lbl">DOWN · ${Math.ceil(pBleed)}s</span>`;
      }
      if (pDowned) {
        aAlert = true;
        this._coopAlert.textContent = inRange ? `⚠ PARTNER DOWN — hold ${key} to revive` : `⚠ PARTNER DOWN — reach them! ${Math.ceil(pBleed)}s`;
      }
    }
    this._coopAlert.style.display = aAlert ? 'block' : 'none';
    this._coopMarker.style.display = aMarker ? 'block' : 'none';
    this._coopName.style.display = aName ? 'block' : 'none';
    this._coopArrow.style.display = aArrow ? 'block' : 'none';
  },

  // MANUAL host (no relays): produce an offer, paste back the guest's answer.
  async coopHostManual(mode) {
    this._coopMode = mode || 'survival';
    const net = createManual('host'); this._pendingNet = net;
    const offer = await net.manual.createOffer();
    const el = this._showCoopOverlay(`
      <div class="coop-title">Manual Host (no relays)</div>
      <div class="coop-sub">1. Copy this offer and send it to your buddy:</div>
      <textarea class="coop-blob" readonly>${offer}</textarea>
      <button class="btn" data-act="copy">⧉ Copy Offer</button>
      <div class="coop-sub">2. Paste the answer they send back:</div>
      <textarea class="coop-blob" data-field="answer" placeholder="Paste answer code…"></textarea>
      <button class="btn primary" data-act="connect">Connect</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="copy"]').addEventListener('click', () => { try { navigator.clipboard.writeText(offer); } catch (e) {} });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    el.querySelector('[data-act="connect"]').addEventListener('click', async () => {
      const ans = el.querySelector('[data-field="answer"]').value.trim();
      const st = el.querySelector('.coop-status');
      if (!ans) { st.textContent = 'Paste the answer code first.'; return; }
      try { await net.manual.acceptAnswer(ans); st.textContent = 'Linking…'; } catch (e) { st.textContent = 'That answer code looks invalid.'; }
    });
    net.onState((s) => { if (s === 'connected' && this.coopRole !== 'host') { this._coopSetStatus(el, 'Connected! Launching…', true); this._coopLaunchTimer = setTimeout(() => { this._pendingNet = null; this._clearCoopOverlay(); this.startCoopHost(net); }, 700); } });
  },

  // MANUAL join (no relays): paste the host's offer, generate an answer to send back.
  coopJoinManual(mode) {
    this._coopMode = mode || 'survival';
    const net = createManual('guest'); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Manual Join (no relays)</div>
      <div class="coop-sub">1. Paste the offer code from the host:</div>
      <textarea class="coop-blob" data-field="offer" placeholder="Paste offer code…"></textarea>
      <button class="btn primary" data-act="answer">Generate Answer</button>
      <div class="coop-sub coop-hidden" data-row="answer">2. Copy this answer and send it back to the host:</div>
      <textarea class="coop-blob coop-hidden" data-field="answerout" data-row="answer" readonly></textarea>
      <button class="btn coop-hidden" data-act="copy" data-row="answer">⧉ Copy Answer</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    this.joinCoop(net);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    el.querySelector('[data-act="answer"]').addEventListener('click', async () => {
      const offer = el.querySelector('[data-field="offer"]').value.trim();
      const st = el.querySelector('.coop-status');
      if (!offer) { st.textContent = 'Paste the offer code first.'; return; }
      try {
        const answer = await net.manual.acceptOffer(offer);
        el.querySelector('[data-field="answerout"]').value = answer;
        el.querySelectorAll('[data-row="answer"]').forEach((n) => n.classList.remove('coop-hidden'));
        st.textContent = 'Waiting for the host to connect…';
      } catch (e) { st.textContent = 'That offer code looks invalid.'; }
    });
    el.querySelector('[data-act="copy"]').addEventListener('click', () => { try { navigator.clipboard.writeText(el.querySelector('[data-field="answerout"]').value); } catch (e) {} });
  },

  _initGuestSurvivalHud() {
    const el = document.createElement('div');
    el.className = 'survival-hud';
    el.innerHTML = `<div class="sv-wave"></div><div class="sv-score"></div><div class="sv-foe"></div>`;
    this.root.appendChild(el);
    this._svHudEl = el;
  },

  // GUEST: the host just mounted the transport — we're the gunner. Ride the seat
  // (position comes from the host's synced transform), free-look to aim, Fire to
  // shoot the host's turret. A vehicle ghost replaces our buddy avatar.
  _guestEnterGunner(objective) {
    this._guestGunner = true;
    if (!this._vehGhost) {
      const mesh = AssetFactory.vehicle();
      this.scene.add(mesh);
      this._vehGhost = { mesh, buf: [] };
    }
    if (this._hostAvatar) this._hostAvatar.visible = false;   // we ride together; show the truck, not the buddy
    if (this._viewModel) this._viewModel.visible = false;
    this.hud.setObjective(objective || 'GUNNER — aim and Fire to clear the road.');
    this.hud.banner('GUNNER', 'You’re on IRIS’s turret — aim and hold Fire to clear the path.', 2.6);
    this.audio.sfx('objective');
  },

  _clearVehGhost() {
    if (this._vehGhost) { this.scene.remove(this._vehGhost.mesh); this._vehGhost = null; }
    this._guestGunner = false;
  },

  // ---------- co-op: campaign mission flow (host-authoritative) ----------
  // GUEST: the host finished the mission. Freeze, then show our own complete screen.
  _guestMissionComplete(finaleDone) {
    if (this.state === 'result' || this._coopLeft) return;
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.audio.sfx('win');
    this.hud.banner('MISSION COMPLETE', CAMPAIGN[this.missionIndex] ? CAMPAIGN[this.missionIndex].outro : '', 3);
    setTimeout(() => { if (this.coopRole === 'guest' && !this._coopLeft && this.state === 'result') this._showCoopResult(!!finaleDone); }, 1600);
  },

  // Shared mission-complete screen, shown on BOTH peers. Each side draws and picks
  // its own upgrade; only the HOST gets the "Next Mission" button (host-only continue).
  // The guest forwards its pick and waits — the host's next 'start' rebuilds its world.
  _showCoopResult(finaleDone) {
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    this._clearCoopHud();
    this._hostPendingPerk = null;
    const host = this.coopRole === 'host';
    const next = this.missionIndex + 1 < CAMPAIGN.length;
    const m = CAMPAIGN[this.missionIndex];
    const owned = host ? this._runPerks : this._guestRunPerks;
    const choices = (!finaleDone && next) ? PERK_IDS.filter((id) => !owned.includes(id)).sort(() => Math.random() - 0.5).slice(0, 3) : [];
    const perkSection = choices.length
      ? `<div class="perk-pick"><div class="perk-pick-head">◆ Choose your upgrade</div><div class="perk-cards">${
        choices.map((id) => `<button class="perk-card" data-perk="${id}"><b>${PERKS[id].name}</b><span>${PERKS[id].desc}</span></button>`).join('')
      }</div></div>` : '';
    const buttons = finaleDone
      ? '<button class="btn primary" data-act="leave">★ Finish</button>'
      : (host
        ? '<button class="btn primary" data-act="continue">▶ Next Mission</button><button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>'
        : '<button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>');
    const el = this._showCoopOverlay(`
      <div class="coop-title">${finaleDone ? 'The Halo Goes Dark' : 'Mission Complete'}</div>
      <div class="coop-sub" style="text-align:center">${finaleDone ? 'Sgt. Orion and his partner ride the wreckage out. The Aureole is silent.' : (m ? m.outro : '')}</div>
      ${perkSection}
      <div class="coop-status"></div>
      <div class="menu-list">${buttons}</div>`);
    el.querySelectorAll('[data-perk]').forEach((b) => b.addEventListener('click', () => {
      this.audio.sfx('objective');
      el.querySelectorAll('[data-perk]').forEach((x) => x.classList.remove('chosen'));
      b.classList.add('chosen');
      this._coopPickPerk(b.dataset.perk);
    }));
    const cont = el.querySelector('[data-act="continue"]');
    if (cont) cont.addEventListener('click', () => this._coopAdvance());
    const leave = el.querySelector('[data-act="leave"]');
    if (leave) leave.addEventListener('click', () => this.quitToMenu());
    if (!host && !finaleDone) this._coopSetStatus(el, 'Host leads — pick your upgrade; you’ll deploy when they continue.');
  },

  // Record an upgrade pick. Host stashes it locally (applied on advance); guest
  // forwards it so the host can apply it to the simulated guest on the next build.
  _coopPickPerk(id) {
    if (this.coopRole === 'host') { this._hostPendingPerk = id; }
    else {
      if (this.net) this.net.send('guestPerk', id);
      const st = this._coopOverlayEl && this._coopOverlayEl.querySelector('.coop-status');
      if (st) st.textContent = 'Upgrade locked in — waiting for the host to continue…';
    }
  },

  // HOST only: commit both players' picks and build the next mission (host-only continue).
  _coopAdvance() {
    if (this.coopRole !== 'host') return;
    if (this._hostPendingPerk && !this._runPerks.includes(this._hostPendingPerk)) this._runPerks.push(this._hostPendingPerk);
    if (this._pendingGuestPerk && !this._guestRunPerks.includes(this._pendingGuestPerk)) this._guestRunPerks.push(this._pendingGuestPerk);
    this._hostPendingPerk = null; this._pendingGuestPerk = null;
    this._clearCoopOverlay();
    this.missionIndex = Math.min(this.missionIndex + 1, CAMPAIGN.length - 1);
    this._coopBuildMission();
  },

  // Shared mission-failed screen (both fell, or an objective/escape failed). Retry
  // rebuilds the SAME mission for both; the guest just asks the host to.
  _showCoopFail(isHost) {
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    this._clearCoopHud();
    const m = CAMPAIGN[this.missionIndex];
    const el = this._showCoopOverlay(`
      <div class="coop-title">You Both Fell</div>
      <div class="coop-sub" style="text-align:center">${m ? m.name : 'The Aureole'} — still linked up.</div>
      <button class="btn primary" data-act="retry">↻ Retry Mission</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="retry"]').addEventListener('click', () => this._coopRetry(el));
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  },
};
