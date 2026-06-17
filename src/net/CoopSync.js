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
    f: !!fireHeld, a: !!input.isDown('ads'), g: !!input.isDown('grenade'), c: !!input.isDown('crouch'),
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
    this._held = { fire: pkt.f, ads: pkt.a, grenade: pkt.g, crouch: pkt.c };
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
    hp: local ? [r2(local.pos.x), r2(local.pos.y), r2(local.pos.z), r3(local.yaw), Math.round(local.health), Math.round(local.shield), local.dead ? 1 : 0] : null,
    gp: guest ? guestState(guest) : null,
    sv: sv ? [sv.wave, sv.score, sv.state, sv._live ? sv._live.filter((x) => !x.dead).length : 0] : null,
    ev: game._netEvents.length ? game._netEvents.splice(0) : null,
  };
}

// The guest's own authoritative state (health/ammo/grenades/score) — drives its
// HUD, since the host owns all of it.
function guestState(g) {
  const w = g.weapon;
  return {
    health: Math.round(g.health), healthMax: g.healthMax, shield: Math.round(g.shield), shieldMax: g.shieldMax, dead: g.dead ? 1 : 0,
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
      g = { mesh, dead: 0 }; game._ghosts.set(id, g);
    }
    g.tx = a[2]; g.ty = a[3]; g.tz = a[4]; g.tf = a[5]; g.dead = a[6]; g.deathT = a[7];
  }
  for (const [id, g] of game._ghosts) { if (!seen.has(id)) { game.scene.remove(g.mesh); disposeMesh(g.mesh); game._ghosts.delete(id); } }

  // projectiles
  const pseen = game._pseenScratch || (game._pseenScratch = new Set());
  pseen.clear();
  for (const a of snap.p) {
    const id = a[0];
    pseen.add(id);
    let pg = game._projGhosts.get(id);
    if (!pg) { const mesh = AssetFactory.projectileMesh(a[1]); mesh.position.set(a[2], a[3], a[4]); game.scene.add(mesh); pg = { mesh }; game._projGhosts.set(id, pg); }
    pg.tx = a[2]; pg.ty = a[3]; pg.tz = a[4];
  }
  for (const [id, pg] of game._projGhosts) { if (!pseen.has(id)) { game.scene.remove(pg.mesh); disposeMesh(pg.mesh); game._projGhosts.delete(id); } }

  // host avatar (the buddy from the guest's POV)
  if (snap.hp && game._hostAvatar) {
    const h = snap.hp;
    game._hostAvatar._tx = h[0]; game._hostAvatar._ty = h[1]; game._hostAvatar._tz = h[2]; game._hostAvatar._tyaw = h[3];
    game._hostAvatar.visible = !h[6];
  }

  // authoritative state for HUD
  if (snap.gp) game._guestNetState = snap.gp;
  if (snap.sv) game._svNetState = snap.sv;

  // one-shot events (banners, telegraphs, explosions…)
  if (snap.ev) for (const ev of snap.ev) applyEvent(game, ev);
}

// Smoothly chase the latest snapshot targets — runs every guest frame.
export function interpolateGhosts(game, dt) {
  const k = Math.min(1, dt * 14);
  for (const [, g] of game._ghosts) {
    g.mesh.position.x += (g.tx - g.mesh.position.x) * k;
    g.mesh.position.y += (g.ty - g.mesh.position.y) * k;
    g.mesh.position.z += (g.tz - g.mesh.position.z) * k;
    g.mesh.rotation.y = g.tf;
    if (g.dead && g.deathT !== undefined) g.mesh.scale.setScalar(Math.max(0.01, g.deathT));
  }
  for (const [, pg] of game._projGhosts) {
    pg.mesh.position.x += (pg.tx - pg.mesh.position.x) * k;
    pg.mesh.position.y += (pg.ty - pg.mesh.position.y) * k;
    pg.mesh.position.z += (pg.tz - pg.mesh.position.z) * k;
  }
  const a = game._hostAvatar;
  if (a && a._tx !== undefined) {
    a.position.x += (a._tx - a.position.x) * k;
    a.position.y += (a._ty - a.position.y) * k;
    a.position.z += (a._tz - a.position.z) * k;
    a.rotation.y = a._tyaw;
  }
}

function applyEvent(game, ev) {
  const k = ev[0];
  if (k === 'banner') game.hud && game.hud.banner(ev[1], ev[2], ev[3]);
  else if (k === 'obj') game.hud && game.hud.setObjective(ev[1]);
  else if (k === 'tel') game._spawnTelegraph(new THREE.Vector3(ev[1], 0, ev[2]), ev[3], ev[4], ev[5]);
  else if (k === 'expl') game._spawnExplosion(new THREE.Vector3(ev[1], ev[2], ev[3]), ev[4]);
  else if (k === 'sfx') game.audio && game.audio.sfx(ev[1]);
  else if (k === 'kill') game.hud && game.hud.killFeed(ev[1], ev[2]);
}

export function clearGhosts(game) {
  if (game._ghosts) { for (const [, g] of game._ghosts) { game.scene.remove(g.mesh); disposeMesh(g.mesh); } game._ghosts.clear(); }
  if (game._projGhosts) { for (const [, pg] of game._projGhosts) { game.scene.remove(pg.mesh); disposeMesh(pg.mesh); } game._projGhosts.clear(); }
}

function disposeMesh(m) {
  m.traverse && m.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { const mm = Array.isArray(o.material) ? o.material : [o.material]; mm.forEach((x) => x.dispose && x.dispose()); } });
}
