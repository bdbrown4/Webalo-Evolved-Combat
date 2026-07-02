// PvpSession.js — Game methods for Deathmatch (duel / FFA / 2v2): the lobby,
// host-authoritative frags/respawns/spawn protection, weapon/health pads, the
// all-players snapshot plumbing, and the scoreboard HUD. Mixed into Game.prototype.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';
import { SURVIVAL_MISSION } from '../ui/Survival.js';
import { serializePvpSnap, applyPvpSnap, NetInputProxy, pvpColor } from '../net/CoopSync.js';
import { hostTrystero, joinTrystero, makeRoomCode } from '../net/Net.js';

// seconds of spawn protection on (re)spawn. Drops early the moment a player
// fires (Player._fire), so it shields against spawn-camping without enabling it.
const PVP_SPAWN_INVULN = 2.5;

export const PvpSessionMixin = {
  // ---------- PvP: Deathmatch — FFA & 2v2 teams (host-authoritative, multi-peer) ----------
  // Who a shooter may damage: enemies in PvE; opposing players in PvP (never self;
  // never a teammate in 2v2). Used by hitscan, projectiles, splash and aim-assist.
  _combatTargets(shooter) {
    if (!this._pvp) return this.enemies;
    const out = [];
    for (const p of this.players) {
      if (!p || p === shooter || p.dead || p.downed) continue;
      if (this._pvp.teams && shooter && p._team != null && p._team === shooter._team) continue;
      out.push(p);
    }
    return out;
  },

  // Weapon/health pads for Deathmatch: fixed, symmetric spots in the seeded arena.
  // Both sides build the same pads; the HOST owns pickup/respawn state and mirrors
  // it with pkt/pkr events, so map control is real (everyone starts rifle+pistol —
  // the power weapons are ON the map).
  _pvpBuildPads() {
    const r = (this.level && this.level.segments[0]) || { cx: 0, cz: 0, w: 30, d: 40 };
    const defs = [
      { id: 0, type: 'health', x: r.cx, z: r.cz },
      { id: 1, type: 'weapon', weapon: 'goocaster', x: r.cx - r.w * 0.3, z: r.cz },
      { id: 2, type: 'weapon', weapon: 'boomstick', x: r.cx + r.w * 0.3, z: r.cz },
    ];
    this._pvpPads = defs.map((d) => {
      const mesh = AssetFactory.pickup(d.type, d.weapon);
      mesh.position.set(d.x, 0.9, d.z);
      this.scene.add(mesh);
      return { ...d, mesh, taken: false, respawnT: 0 };
    });
  },

  // spin the pad diamonds (host + guest, every frame)
  _pvpAnimatePads(dt) {
    if (!this._pvpPads) return;
    for (const pad of this._pvpPads) { pad.mesh.rotation.y += dt * 1.5; if (pad.mesh.userData.spin) pad.mesh.userData.spin.rotation.x += dt * 2; }
  },

  // HOST: resolve pad pickups + respawns (20s), mirroring state to guests.
  _pvpUpdatePads(dt) {
    if (!this._pvpPads) return;
    for (const pad of this._pvpPads) {
      if (pad.taken) {
        pad.respawnT -= dt;
        if (pad.respawnT <= 0) { pad.taken = false; pad.mesh.visible = true; this._netPush('pkr', pad.id); }
        continue;
      }
      for (const p of this.players) {
        if (!p || p.dead || p.downed) continue;
        if (p.pos.distanceToSquared(pad.mesh.position) > 1.6 * 1.6) continue;
        if (pad.type === 'health') {
          if (p.health >= p.healthMax) continue;          // full — leave it for someone who needs it
          p.addHealth(30);
        } else p.giveWeapon(pad.weapon);
        pad.taken = true; pad.respawnT = 20; pad.mesh.visible = false;
        this.audio.sfx('pickup');
        this._netPush('pkt', pad.id);
        if (p === this.player) this.hud.banner(pad.type === 'health' ? '+30 HEALTH' : 'PICKED UP', pad.type === 'health' ? '' : pad.weapon.toUpperCase(), 0.9);
        break;
      }
    }
  },

  // GUEST: a pad event from the host (taken / respawned).
  _pvpPadNet(id, taken) {
    const pad = this._pvpPads && this._pvpPads.find((x) => x.id === id);
    if (!pad) return;
    pad.taken = taken; pad.mesh.visible = !taken;
    if (taken) this.audio.sfx('pickup');
  },

  // Up to four spawns at the arena corners, each facing the centre.
  _pvpSpawns(n) {
    const r = (this.level && this.level.segments[0]) || { cx: 0, cz: 0, w: 30, d: 40 };
    const rx = r.w * 0.32, rz = r.d * 0.32;
    const corners = [[-rx, -rz], [rx, rz], [rx, -rz], [-rx, rz]];
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = corners[i % 4];
      const v = new THREE.Vector3(r.cx + c[0], 1.2, r.cz + c[1]);
      v.yaw = Math.atan2(-c[0], -c[1]);     // look toward centre
      out.push(v);
    }
    return out;
  },

  // Pick the corner farthest from any living rival so a respawn doesn't drop you
  // in someone's crosshairs. Teammates (2v2) don't count as threats. Combined with
  // brief spawn protection (_invulnT), this defuses spawn-camping.
  _pvpPickSpawn(forPlayer) {
    const spawns = this._pvpSpawnPts && this._pvpSpawnPts.length ? this._pvpSpawnPts : this._pvpSpawns(4);
    let best = spawns[0], bestDist = -Infinity;
    for (const s of spawns) {
      let nearest = Infinity;
      for (const o of this.players) {
        if (!o || o === forPlayer || o.dead || o.downed) continue;
        if (this._pvp && this._pvp.teams && o._team === forPlayer._team) continue;   // a teammate is no threat
        nearest = Math.min(nearest, o.pos.distanceTo(s));
      }
      if (nearest > bestDist) { bestDist = nearest; best = s; }   // Infinity (no rivals) wins outright
    }
    return best;
  },

  // HOST lobby → start: wire the one-time net handlers (input is tagged by peerId so
  // each guest's controls reach the right body), then build the first round.
  startPvpHost(net) {
    this.net = net; this.coopRole = 'host';
    this._coopOver = false; this._coopLeft = false;
    this._lobbyClosed = true;                            // late joiners get 'full', not a seat
    this._pvpPeers = (this._lobbyPeers || []).slice();   // peers gathered in the lobby
    net.on('input', (pkt, peerId) => { const g = this._pvpGuests && this._pvpGuests.get(peerId); if (g && g._netInput) g._netInput.feed(pkt); });
    net.on('rematchReq', () => { if (this._pvp && this._pvp.over) this._pvpBuild(); });
    net.onPeerGone((id) => this._onPvpPeerGone(id));
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
    this._pvpBuild();
  },

  // HOST: (re)build the arena under a shared seed, drop every player at a corner, assign
  // teams, and ship each guest a targeted 'start'. _pvp is set AFTER _beginMission (whose
  // teardown clears it), so it can never leak into a later run.
  _pvpBuild() {
    this._coopOver = false; this._coopLeft = false;
    this._setRunMods([]); this._daily = null; this._resume = false;
    this._levelSeed = (Date.now() & 0x7fffffff) || 1;
    this._beginMission(SURVIVAL_MISSION);
    this.level.freeplay = true;
    const teams = this._pvpConfig.mode === 'teams';
    this._pvp = { fragLimit: this._pvpConfig.fragLimit, mode: this._pvpConfig.mode, teams, over: false };
    const peers = this._pvpPeers;
    const sp = this._pvpSpawns(peers.length + 1);
    this._pvpSpawnPts = this._pvpSpawns(4);     // full corner set, for respawn placement
    this._pvpGuests = new Map();
    // host = player id 0
    this._pvpArm(this.player, sp[0], 0, teams ? 0 : 0, 'You');
    this.player._syncCamera(this.settings, 0);
    // one body per connected peer
    peers.forEach((peerId, i) => {
      const pid = i + 1, team = teams ? pid % 2 : pid;
      const g = this.addRemotePlayer(sp[pid], { color: pvpColor(teams, pid, team), id: 'p' + pid, weapons: ['rifle', 'pistol'] });
      g._netInput = new NetInputProxy();
      this._pvpArm(g, sp[pid], pid, team, teams ? `${team === 0 ? 'Blue' : 'Red'} ${Math.ceil(pid / 2)}` : 'P' + (pid + 1));
      g._peerId = peerId;                    // so host→guest unicasts (respawn) can find them
      this._pvpGuests.set(peerId, g);
      this.net.send('start', { seed: this._levelSeed, mode: this._pvp.mode, fragLimit: this._pvp.fragLimit,
        myId: pid, team, players: peers.length + 1,
        spawn: { x: sp[pid].x, y: sp[pid].y, z: sp[pid].z, yaw: sp[pid].yaw } }, peerId);
    });
    this._pvpBuildPads();
    this._ensurePvpHud();
    this.hud.banner(teams ? 'TEAM DEATHMATCH' : this._pvp.mode === 'duel' ? 'DUEL' : 'FREE-FOR-ALL', `First to ${this._pvp.fragLimit} frags${teams ? ' (team total)' : ''}.`, 2.6);
  },

  // Configure a player as a PvP combatant: a fixed spawn, id/team/name, fresh score,
  // and "dies, not downs" rules.
  _pvpArm(p, spawn, pid, team, name) {
    p.pos.copy(spawn); p.yaw = spawn.yaw || 0; p.vel.set(0, 0, 0);
    p.downable = false; p.dead = false; p.downed = false;
    p.health = p.healthMax; p.shield = p.shieldMax; p.regenT = 0;
    p._pid = pid; p._team = team; p._pvpName = name; p._frags = 0; p._spawn = spawn;
    p._respawnT = null; p._pvpDeadHandled = false; p.lastAttacker = null;
    p._invulnT = PVP_SPAWN_INVULN;                  // brief shield off the start line
    if (p._avatar) p._avatar.visible = true;
  },

  _pvpRespawn(p) {
    const s = this._pvpPickSpawn(p) || p._spawn;    // farthest corner from the living rivals
    p.dead = false; p.downed = false; p.health = p.healthMax; p.shield = p.shieldMax; p.regenT = 0;
    p.pos.copy(s); p.vel.set(0, 0, 0); p.yaw = s.yaw || 0; p.lastAttacker = null;
    p._invulnT = PVP_SPAWN_INVULN;                  // spawn protection — drops the moment they fire (Player._fire)
    if (p === this.player) {
      this.player._syncCamera(this.settings, 0);
      this.input.clearTransient();                  // don't carry a death-frame press into the respawn
      this.hud.banner('RESPAWN', 'Spawn shield up — fire to drop it.', 1.4);
    } else if (p._peerId && this.net) {
      // tell the guest WHERE it respawned — guests are movement-authoritative and
      // snap themselves on the dead→alive edge, so without this they'd snap back
      // to their original corner and instantly override the host's pick.
      this.net.send('respawn', { x: s.x, y: s.y, z: s.z, yaw: s.yaw || 0 }, p._peerId);
    }
    if (p._avatar) p._avatar.visible = true;
  },

  _teamFrags(team) { let t = 0; for (const p of this.players) if (p && p._team === team) t += (p._frags || 0); return t; },

  // HOST: deaths → frags → respawns → win. Runs each frame while a match is live.
  _pvpUpdate(dt) {
    if (!this._pvp) return;
    this._pvpAnimatePads(dt);
    this._pvpUpdatePads(dt);
    for (const p of this.players) {
      if (p._invulnT > 0) p._invulnT -= dt;            // spawn protection ticking down
      // frag attribution decays: a hit from a minute ago shouldn't claim a later self-kill
      if (p.lastAttacker && !p.dead) { p.lastAttackerT = (p.lastAttackerT || 0) + dt; if (p.lastAttackerT > 5) p.lastAttacker = null; }
      if (p.dead && !p._pvpDeadHandled) {
        p._pvpDeadHandled = true; p._respawnT = 3.0;
        if (p._avatar) p._avatar.visible = false;
        const killer = p.lastAttacker;
        const selfKill = !killer || killer === p || (this._pvp.teams && killer._team === p._team);
        if (!selfKill) killer._frags = (killer._frags || 0) + 1;
        const kName = selfKill ? '☠' : killer._pvpName;
        this.hud.killFeed(`${kName} ▸ ${p._pvpName}`, selfKill ? 0x9aa7b3 : 0xff6a3d);
        this._netPush('frag', kName, p._pvpName);
        if (!selfKill) {
          if (this._pvp.teams) { if (this._teamFrags(killer._team) >= this._pvp.fragLimit) { this._pvpEnd(killer); return; } }
          else if (killer._frags >= this._pvp.fragLimit) { this._pvpEnd(killer); return; }
        }
      }
      if (p.dead && p._respawnT != null) {
        p._respawnT -= dt;
        if (p._respawnT <= 0 && !this._pvp.over) { p._respawnT = null; p._pvpDeadHandled = false; this._pvpRespawn(p); }
      }
    }
  },

  // A peer dropped mid-match — remove its body so the match continues for the rest.
  _onPvpPeerGone(id) {
    if (!this._pvpGuests) return;
    const g = this._pvpGuests.get(id);
    if (!g) return;
    this._pvpGuests.delete(id);
    if (g._avatar) this.scene.remove(g._avatar);
    const i = this.players.indexOf(g); if (i >= 0) this.players.splice(i, 1);
    if (this._pvpPeers) { const pi = this._pvpPeers.indexOf(id); if (pi >= 0) this._pvpPeers.splice(pi, 1); }
    this.hud.killFeed(`${g._pvpName} left`, 0x9aa7b3);
    if (this._pvpGuests.size === 0) this._onPeerLeft();   // last rival gone → end
  },

  _pvpEnd(winner) {
    this._pvp.over = true;
    const meWon = this._pvp.teams ? winner._team === this.player._team : winner === this.player;
    this._netPush('pvpover', winner._pid, winner._pvpName, this._pvp.teams ? 1 : 0, winner._team);
    if (this.net) this.net.send('pvpsnap', serializePvpSnap(this));   // flush the result now
    this._showPvpOver(meWon, winner._pvpName);
  },

  // GUEST: register handlers; the arena is built when the host's 'start' arrives.
  joinPvp(net) {
    this.net = net; this.coopRole = 'guest';
    this._coopOver = false; this._coopLeft = false;
    net.on('start', (d) => this._beginPvpGuest(d));
    net.on('pvpsnap', (snap) => { applyPvpSnap(this, snap); });
    // the host picks each respawn corner (farthest from rivals) — adopt it so our
    // dead→alive self-snap lands where the host put our body
    net.on('respawn', (d) => { if (this._mySpawn) { this._mySpawn.set(d.x, d.y, d.z); this._mySpawn.yaw = d.yaw || 0; } });
    net.on('full', () => this._coopFullNotice());
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
  },

  _beginPvpGuest(d) {
    this._netClock = 0;
    this._levelSeed = d.seed;
    this._setRunMods([]); this._daily = null; this._resume = false; this._runPerks = [];
    this._beginMission(SURVIVAL_MISSION);      // teardown clears any prior _pvp
    this.level.freeplay = true;
    this._pvp = { fragLimit: d.fragLimit || 15, mode: d.mode, teams: d.mode === 'teams', over: false };
    this._myId = d.myId; this._myTeam = d.team;
    this.player.downable = false; this.player._pid = d.myId; this.player._team = d.team;
    if (d.spawn) { this._mySpawn = new THREE.Vector3(d.spawn.x, d.spawn.y, d.spawn.z); this._mySpawn.yaw = d.spawn.yaw || Math.PI;
      this.player.pos.copy(this._mySpawn); this.player.yaw = this._mySpawn.yaw; this.player._syncCamera(this.settings, 0); }
    this._pvpBuildPads();                      // host mirrors taken/respawn via pkt/pkr
    this._pvpAvatars = new Map();              // every OTHER player, drawn from snapshots
    this._pvpMe = null; this._pvpBoard = null; this._wasPvpDead = false;
    this._ensurePvpHud();
    this._clearCoopOverlay(); this._clearResult();
    this.hud.banner(d.mode === 'teams' ? 'TEAM DEATHMATCH' : d.mode === 'duel' ? 'DUEL' : 'FREE-FOR-ALL', `First to ${this._pvp.fragLimit} frags.`, 2.6);
  },

  // ---------- PvP: lobby ----------
  // HOST: open a room, gather peers, let the host start when ready. opts = { mode, fragLimit }.
  pvpHost(opts) {
    const code = makeRoomCode();
    const net = hostTrystero(code); this._pendingNet = net;
    const mode = (opts && opts.mode) || 'ffa';
    this._pvpConfig = { fragLimit: (opts && opts.fragLimit) || 15, mode };
    this._lobbyPeers = [];
    const duel = mode === 'duel';
    const cap = duel ? 2 : 4;                          // duel = exactly two players
    const modeName = duel ? '1v1 Duel' : mode === 'teams' ? '2v2 Teams' : 'Free-for-All';
    const launch = () => { this._pendingNet = null; this._clearCoopOverlay(); this.startPvpHost(net); };
    const el = this._showCoopOverlay(`
      <div class="coop-title">Hosting ${modeName}</div>
      <div class="coop-sub">Share this code — ${duel ? 'your rival opens' : 'rivals open'} <b>Deathmatch</b> and pick${duel ? 's' : ''} <b>Join</b>:</div>
      <div class="coop-code">${code}</div>
      <button class="btn" data-act="copy">⧉ Copy Code</button>
      <div class="coop-sub" style="margin-top:8px">First to <b>${this._pvpConfig.fragLimit}</b> frags · ${duel ? '2 players' : 'up to <b>' + cap + '</b> players'}.</div>
      <div class="pvp-roster" data-roster>You (host)</div>
      ${duel ? '<div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Waiting for your rival to join…</span></div>' : '<button class="btn primary" data-act="start" disabled>▶ Start Match</button>'}
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    const copyBtn = el.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy Code'; }, 1200); } catch (e) {} });
    const startBtn = el.querySelector('[data-act="start"]');
    const roster = el.querySelector('[data-roster]');
    const refresh = () => { roster.innerHTML = 'You (host)' + this._lobbyPeers.map((_, i) => `<br>Player ${i + 2} — joined`).join(''); if (startBtn) startBtn.disabled = this._lobbyPeers.length < 1; };
    this._lobbyClosed = false;
    net.onPeer((id) => {
      if (this._lobbyClosed) { if (!this._pvpGuests || !this._pvpGuests.has(id)) net.send('full', 1, id); return; }  // match underway
      if (this._lobbyPeers.length < cap - 1 && !this._lobbyPeers.includes(id)) { this._lobbyPeers.push(id); this.audio.sfx('ui'); refresh(); }
      else if (!this._lobbyPeers.includes(id)) { net.send('full', 1, id); return; }   // roster full — turn them away
      // a 1v1 needs no "Start" — launch as soon as the single rival connects
      if (duel && this._lobbyPeers.length >= 1) { this._coopSetStatus(el, 'Rival connected! Launching…', true); this._coopLaunchTimer = setTimeout(launch, 700); }
    });
    net.onPeerGone((id) => { const i = this._lobbyPeers.indexOf(id); if (i >= 0) { this._lobbyPeers.splice(i, 1); refresh(); } });
    if (startBtn) startBtn.addEventListener('click', () => { if (!this._lobbyPeers.length) return; launch(); });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
  },

  pvpJoin(code) {
    const net = joinTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Joining ${code}</div>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Reaching the host…</span></div>
      <div class="coop-dim">Peer-to-peer can take a few seconds to link up.</div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    this.joinPvp(net);
    this._coopReassure = setTimeout(() => this._coopSetStatus(el, 'Still linking… hang tight (relays can be slow).'), 5000);
    this._coopFailTimer = setTimeout(() => { if (!this.level) this._coopFail(el, net, 'Couldn’t reach the host. Double-check the code and that they’re still hosting.'); }, 25000);
    net.onState((s) => { if (s === 'connected') this._coopSetStatus(el, 'Connected! Waiting for the host to start…', true); });
  },

  // ---------- PvP: scoreboard HUD ----------
  _ensurePvpHud() {
    if (this._pvpHud) return;
    const el = document.createElement('div');
    el.className = 'pvp-hud';
    el.innerHTML = '<div class="pvp-board"></div><div class="pvp-respawn"></div>';
    this.root.appendChild(el);
    this._pvpHud = el;
  },

  _clearPvpHud() { if (this._pvpHud) { this._pvpHud.remove(); this._pvpHud = null; } },

  // Build a normalized scoreboard ({rows, respawn}) from whichever side we're on.
  _pvpScore() {
    if (this.coopRole === 'host') {
      const rows = this.players.filter((p) => p).map((p) => ({ name: p._pvpName, team: p._team, frags: p._frags || 0, me: p === this.player }));
      const respawn = this.player._respawnT != null ? Math.ceil(this.player._respawnT) : 0;
      return { rows, respawn };
    }
    const rows = (this._pvpBoard || []).map((b) => ({ name: b.name, team: b.team, frags: b.frags, me: b.pid === this._myId }));
    const respawn = this._pvpMe && this._pvpMe.respawnT ? this._pvpMe.respawnT : 0;
    return { rows, respawn };
  },

  _updatePvpHud() {
    if (!this._pvp || this.state !== 'playing') { if (this._pvpHud) this._pvpHud.style.display = 'none'; return; }
    this._ensurePvpHud(); this._pvpHud.style.display = '';
    const { rows, respawn } = this._pvpScore();
    let html = '';
    if (this._pvp.teams) {
      const t0 = rows.filter((r) => r.team % 2 === 0).reduce((s, r) => s + r.frags, 0);
      const t1 = rows.filter((r) => r.team % 2 === 1).reduce((s, r) => s + r.frags, 0);
      const mine = this._myTeamParity();
      html = `<div class="pvp-teams"><span class="pt a ${mine === 0 ? 'mine' : ''}">BLUE ${t0}</span><span class="pvp-sep">—</span><span class="pt b ${mine === 1 ? 'mine' : ''}">RED ${t1}</span></div><div class="pvp-limit">first to ${this._pvp.fragLimit}</div>`;
    } else {
      const sorted = rows.slice().sort((a, b) => b.frags - a.frags);
      html = '<div class="pvp-list">' + sorted.map((r) => `<div class="pvp-row ${r.me ? 'mine' : ''}"><span class="pr-n">${r.name}</span><span class="pr-f">${r.frags}</span></div>`).join('') + `</div><div class="pvp-limit">first to ${this._pvp.fragLimit}</div>`;
    }
    this._pvpHud.querySelector('.pvp-board').innerHTML = html;
    this._pvpHud.querySelector('.pvp-respawn').textContent = respawn > 0 ? 'RESPAWNING IN ' + respawn : '';
  },

  _myTeamParity() { const t = this.coopRole === 'host' ? this.player._team : this._myTeam; return (t || 0) % 2; },

  _showPvpOver(meWon, winnerName) {
    this.audio.sfx(meWon ? 'win' : 'lose');
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result'; this.hud.show(false);
    if (this._pvpHud) this._pvpHud.style.display = 'none';
    const host = this.coopRole === 'host';
    const { rows } = this._pvpScore();
    const board = rows.slice().sort((a, b) => b.frags - a.frags)
      .map((r) => `<div class="pvp-row ${r.me ? 'mine' : ''}"><span class="pr-n">${r.name}</span><span class="pr-f">${r.frags}</span></div>`).join('');
    const el = this._showCoopOverlay(`
      <div class="coop-title">${meWon ? 'Victory' : 'Defeat'}</div>
      <div class="coop-sub" style="text-align:center">${winnerName} ${this._pvp && this._pvp.teams ? 'team takes' : 'takes'} it</div>
      <div class="pvp-list final">${board}</div>
      ${host ? '<button class="btn primary" data-act="rematch">↻ Rematch</button>' : '<div class="coop-status">Waiting for host to rematch…</div>'}
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    const rm = el.querySelector('[data-act="rematch"]');
    if (rm) rm.addEventListener('click', () => { this._clearCoopOverlay(); this._pvpBuild(); });
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  },

  // GUEST entry for the broadcast end-of-match event from the host.
  _guestPvpOver(winnerPid, winnerName, teams, winnerTeam) {
    if (this.state === 'result') return;
    if (this._pvp) this._pvp.over = true;
    const won = teams ? (winnerTeam % 2) === this._myTeamParity() : winnerPid === this._myId;
    this._showPvpOver(won, winnerName);
  },
};
