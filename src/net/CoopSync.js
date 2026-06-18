// CoopSync.js — the host-authoritative sync layer for 2-player co-op.
//
// The HOST runs the entire simulation (enemies, projectiles, both players,
// Survival waves/score) exactly as in solo play, then ~20x/sec serializes a
// compact world SNAPSHOT and ships it to the guest. The GUEST runs no AI: it
// predicts its own movement/aim locally for responsiveness, forwards its INPUT
// to the host, and renders everything else from snapshots (enemy/projectile
// "ghosts" it lerps between updates, the host's avatar, and its own
// host-authoritative health/ammo/score).
//
// Determinism only matters for one thing — the arena both sides walk around in —
// so we seed Math.random for the duration of level.build() with a shared seed.
// Everything else (enemy RNG, spawns) runs on the host alone, so it never needs
// to match.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';

export const NET_SNAP_HZ = 20;
export const NET_SNAP_DT = 1 / NET_SNAP_HZ;
export const NET_INPUT_HZ = 30;
export const NET_INPUT_DT = 1 / NET_INPUT_HZ;

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// Snapshot interpolation: render entities ~80ms in the past, smoothly between the
// two buffered samples bracketing that time, so 20Hz updates read as fluid motion.
const INTERP_DELAY = 0.08;
const BUF_MAX = 6;
function pushSample(buf, t, x, y, z, f) { buf.push({ t, x, y, z, f }); if (buf.length > BUF_MAX) buf.shift(); }
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
function sampleAt(buf, rt) {
  const n = buf.length;
  if (n === 1) return buf[0];
  if (rt >= buf[n - 1].t) return buf[n - 1];                 // starved → hold the newest
  for (let i = n - 1; i > 0; i--) {
    if (buf[i - 1].t <= rt) {
      const a = buf[i - 1], b = buf[i], span = b.t - a.t;
      const k = span > 1e-4 ? (rt - a.t) / span : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, f: lerpAngle(a.f, b.f, k) };
    }
  }
  return buf[0];                                             // older than the buffer → clamp oldest
}

// Run `fn` with Math.random replaced by a seeded LCG, so the host and guest
// build byte-identical arenas from the same seed. Restores the real RNG after.
export function withSeededRandom(seed, fn) {
  const orig = Math.random;
  let s = (seed >>> 0) || 1;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  try { return fn(); } finally { Math.random = orig; }
}

// ---- guest -> host: input packet ------------------------------------------
const EDGE_ACTIONS = ['reload', 'swap', 'weapon1', 'weapon2', 'nadeswap', 'melee', 'flashlight'];

export function serializeInput(player, input, touch, seq) {
  const ev = [];
  for (const a of EDGE_ACTIONS) if (input.pressed(a)) ev.push(a);
  const fireHeld = (touch ? (touch.fireHeld || touch.tapFire) : false) || input.isDown('fire');
  return {
    seq,
    x: r2(player.pos.x), y: r2(player.pos.y), z: r2(player.pos.z),
    yaw: r3(player.yaw), pitch: r3(player.pitch), h: r2(player.curHeight),
    f: !!fireHeld, a: !!input.isDown('ads'), g: !!input.isDown('grenade'), c: !!input.isDown('crouch'), i: !!input.isDown('interact'),
    ev,
  };
}

// Host-side stand-in for the guest's Input. Player.update (remote branch) reads
// it exactly like a real Input, but only combat actions matter — the host trusts
// the guest's reported transform for movement/look, so wasd/jump go unread.
export class NetInputProxy {
  constructor() {
    this.enabled = true;
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this._held = {}; this._prevHeld = {}; this._evQueue = [];
    this._frameEv = new Set(); this._fireEdge = false; this._nadeEdge = false;
    this.latest = null;
  }
  feed(pkt) {
    this._held = { fire: pkt.f, ads: pkt.a, grenade: pkt.g, crouch: pkt.c, interact: pkt.i };
    if (pkt.ev && pkt.ev.length) this._evQueue.push(...pkt.ev);
    this.latest = pkt;
  }
  beginFrame() {
    this._fireEdge = !!this._held.fire && !this._prevHeld.fire;
    this._nadeEdge = !!this._held.grenade && !this._prevHeld.grenade;
    this._frameEv = new Set(this._evQueue); this._evQueue.length = 0;
    this._prevHeld = Object.assign({}, this._held);
  }
  isDown(a) { return !!this._held[a]; }
  pressed(a) { if (a === 'fire') return this._fireEdge; if (a === 'grenade') return this._nadeEdge; return this._frameEv.has(a); }
  takeWheel() { return 0; }
}

// ---- host -> guest: world snapshot ----------------------------------------
// Arrays not objects, to keep the JSON small at 20Hz. Index layouts are mirrored
// in applySnapshot below.
export function serializeSnapshot(game) {
  const local = game.player;                                   // host's own player
  const guest = game.players.find((p) => p && p._netInput);    // the guest, simulated on the host
  const sv = game.survival;
  const e = [];
  for (const en of game.enemies) e.push([en.id, en.type, r2(en.pos.x), r2(en.pos.y), r2(en.pos.z), r3(en.facing), en.dead ? 1 : 0, r2(en.deathT)]);
  const p = [];
  for (const pr of game.projectiles) p.push([pr.id, pr.type, r2(pr.pos.x), r2(pr.pos.y), r2(pr.pos.z)]);
  return {
    e, p,
    hp: local ? [r2(local.pos.x), r2(local.pos.y), r2(local.pos.z), r3(local.yaw), Math.round(local.health), Math.round(local.shield), pstate(local), Math.ceil(local.bleedT), r2(local.reviveProg)] : null,
    gp: guest ? guestState(guest) : null,
    sv: sv ? [sv.wave, sv.score, sv.state, sv._live ? sv._live.filter((x) => !x.dead).length : 0] : null,
    pvp: game._pvp ? [local ? (local._frags || 0) : 0, guest ? (guest._frags || 0) : 0, game._pvp.over ? 1 : 0] : null,
    ev: game._netEvents.length ? game._netEvents.splice(0) : null,
  };
}

// 0 = up, 1 = downed, 2 = dead — compact player-state code for snapshots.
function pstate(p) { return p.dead ? 2 : p.downed ? 1 : 0; }

// The guest's own authoritative state (health/ammo/grenades/score) — drives its
// HUD, since the host owns all of it.
function guestState(g) {
  const w = g.weapon;
  return {
    health: Math.round(g.health), healthMax: g.healthMax, shield: Math.round(g.shield), shieldMax: g.shieldMax, dead: g.dead ? 1 : 0,
    downed: g.downed ? 1 : 0, bleedT: Math.ceil(g.bleedT), reviveProg: r2(g.reviveProg),
    respawnT: g._respawnT != null ? Math.ceil(g._respawnT) : 0,
    weapon: w ? w.name : '—', altName: w && w.def.alt ? w.def.alt.name : null, reticle: w ? w.def.reticle : 'dot',
    ammo: w ? w.ammo : 0, reserve: w ? w.reserve : 0, reloading: w ? w.reloading > 0 : false,
    grenades: g.grenades, grenadeType: g.grenadeType,
    cook: g.cooking ? (g.cooking.sticky ? 1 : Math.max(0, g.cooking.fuse / g.cooking.max)) : null,
  };
}

// ---- guest: apply a snapshot ----------------------------------------------
// Reconciles ghost meshes by id (create new, retarget existing, remove gone) and
// stashes the latest authoritative state. Actual mesh motion is lerped toward
// these targets each frame in interpolateGhosts().
export function applySnapshot(game, snap) {
  // enemies
  const seen = game._seenScratch || (game._seenScratch = new Set());
  seen.clear();
  for (const a of snap.e) {
    const id = a[0];
    seen.add(id);
    let g = game._ghosts.get(id);
    if (!g) {
      const mesh = AssetFactory.enemy(a[1]);
      mesh.position.set(a[2], a[3], a[4]);
      game.scene.add(mesh);
      g = { mesh, buf: [] }; game._ghosts.set(id, g);
    }
    g.dead = a[6]; g.deathT = a[7];
    pushSample(g.buf, game._netClock || 0, a[2], a[3], a[4], a[5]);
  }
  for (const [id, g] of game._ghosts) { if (!seen.has(id)) { game.scene.remove(g.mesh); disposeMesh(g.mesh); game._ghosts.delete(id); } }

  // projectiles
  const pseen = game._pseenScratch || (game._pseenScratch = new Set());
  pseen.clear();
  for (const a of snap.p) {
    const id = a[0];
    pseen.add(id);
    let pg = game._projGhosts.get(id);
    if (!pg) { const mesh = AssetFactory.projectileMesh(a[1]); mesh.position.set(a[2], a[3], a[4]); game.scene.add(mesh); pg = { mesh, buf: [] }; game._projGhosts.set(id, pg); }
    pushSample(pg.buf, game._netClock || 0, a[2], a[3], a[4], 0);
  }
  for (const [id, pg] of game._projGhosts) { if (!pseen.has(id)) { game.scene.remove(pg.mesh); disposeMesh(pg.mesh); game._projGhosts.delete(id); } }

  // host avatar (the buddy from the guest's POV) + the host's down/bleed/revive state
  if (snap.hp) {
    const h = snap.hp;
    if (game._hostAvatar) {
      if (!game._hostAvatar._buf) game._hostAvatar._buf = [];
      pushSample(game._hostAvatar._buf, game._netClock || 0, h[0], h[1], h[2], h[3]);
      game._hostAvatar.visible = h[6] !== 2;       // hidden once truly dead
    }
    game._hostState = { st: h[6], bleedT: h[7], reviveProg: h[8], health: h[4] };
  }

  // authoritative state for HUD + our own down/dead status (drives the guest freeze + UI)
  if (snap.gp) {
    game._guestNetState = snap.gp;
    if (game.player) { game.player.downed = !!snap.gp.downed; game.player.dead = !!snap.gp.dead; }
  }
  if (snap.sv) game._svNetState = snap.sv;
  if (snap.pvp) game._pvpNetState = snap.pvp;

  // one-shot events (banners, telegraphs, explosions…)
  if (snap.ev) for (const ev of snap.ev) applyEvent(game, ev);
}

// Smoothly chase the latest snapshot targets — runs every guest frame.
export function interpolateGhosts(game, dt) {
  const rt = (game._netClock || 0) - INTERP_DELAY;
  for (const [, g] of game._ghosts) {
    if (g.buf && g.buf.length) { const s = sampleAt(g.buf, rt); g.mesh.position.set(s.x, s.y, s.z); g.mesh.rotation.y = s.f; }
    if (g.dead && g.deathT !== undefined) g.mesh.scale.setScalar(Math.max(0.01, g.deathT));
  }
  for (const [, pg] of game._projGhosts) {
    if (pg.buf && pg.buf.length) { const s = sampleAt(pg.buf, rt); pg.mesh.position.set(s.x, s.y, s.z); }
  }
  const a = game._hostAvatar;
  if (a && a._buf && a._buf.length) { const s = sampleAt(a._buf, rt); a.position.set(s.x, s.y, s.z); a.rotation.y = s.f; }
  // co-op gunner: the vehicle the guest rides follows the host's synced transform
  // (while driving, the host's player position IS the vehicle's).
  if (game._vehGhost && a) { game._vehGhost.mesh.position.copy(a.position); game._vehGhost.mesh.rotation.y = a.rotation.y; }
}

function applyEvent(game, ev) {
  const k = ev[0];
  if (k === 'banner') game.hud && game.hud.banner(ev[1], ev[2], ev[3]);
  else if (k === 'obj') game.hud && game.hud.setObjective(ev[1]);
  else if (k === 'tel') game._spawnTelegraph(new THREE.Vector3(ev[1], 0, ev[2]), ev[3], ev[4], ev[5]);
  else if (k === 'expl') game._spawnExplosion(new THREE.Vector3(ev[1], ev[2], ev[3]), ev[4]);
  else if (k === 'sfx') game.audio && game.audio.sfx(ev[1]);
  else if (k === 'kill') game.hud && game.hud.killFeed(ev[1], ev[2]);
  else if (k === 'esc') game.hud && game.hud.setEscape(ev[1]);
  else if (k === 'coopover') game._showCoopOver(ev[1], ev[2], false);
  else if (k === 'mcomplete') game._guestMissionComplete(ev[1]);
  else if (k === 'coopfail') game._showCoopFail(false);
  else if (k === 'frag') game.hud && game.hud.killFeed((ev[1] || '—') + ' ▸ ' + ev[2], ev[1] === '☠' ? 0x9aa7b3 : 0xff6a3d);
  else if (k === 'pvpover') game._guestPvpOver(ev[1], ev[2], ev[3]);
  else if (k === 'mountveh') game._guestEnterGunner(ev[1]);
  else if (k === 'vfire') {                                    // co-op turret: the guest's own shot
    game._spawnTracer(new THREE.Vector3(ev[1], ev[2], ev[3]), new THREE.Vector3(ev[4], ev[5], ev[6]));
    game.audio && game.audio.sfx('rifle');
    if (ev[7] && game.hud) game.hud.hitMark();
  }
}

export function clearGhosts(game) {
  if (game._ghosts) { for (const [, g] of game._ghosts) { game.scene.remove(g.mesh); disposeMesh(g.mesh); } game._ghosts.clear(); }
  if (game._projGhosts) { for (const [, pg] of game._projGhosts) { game.scene.remove(pg.mesh); disposeMesh(pg.mesh); } game._projGhosts.clear(); }
}

function disposeMesh(m) {
  m.traverse && m.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { const mm = Array.isArray(o.material) ? o.material : [o.material]; mm.forEach((x) => x.dispose && x.dispose()); } });
}
