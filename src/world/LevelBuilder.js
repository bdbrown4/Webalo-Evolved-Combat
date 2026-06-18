// LevelBuilder.js — converts a mission's `segments` data into a playable level:
// a sequence of rooms laid out along +Z, connected by doorways. The player
// advances room-by-room; a door stays locked until the current segment is
// "cleared" (enemies dead + any reactor activated + boss defeated). It also
// places cover, pickups, reactor consoles, the boss, and runs the finale's
// vehicle-escape countdown. Geometry is registered with Physics for collision.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';

const SIZE = { s: { w: 16, d: 16 }, m: { w: 22, d: 20 }, l: { w: 30, d: 26 } };
const WALL_H = 6;
const DOOR_W = 5;

export class LevelBuilder {
  constructor() {
    this.group = new THREE.Group();
    this.segments = [];
    this.activeIndex = -1;
    this.pickups = [];
    this.consoles = [];
    this.doors = [];
    this.complete = false;
    this.failed = false;
    this.escapeTime = 0;
    this.inEscape = false;
    this._dialogueQueuedFor = -1;
  }

  build(mission, physics, ctx) {
    this.mission = mission;
    this.physics = physics;
    physics.floorY = 0; // normal safety floor; the escape track drops it to a void
    const accent = new THREE.Color(mission.palette.accent);
    const floorTex = AssetFactory.surfaceTexture('floor');
    const wallTex = AssetFactory.surfaceTexture('wall');
    // per-room material with a texture clone whose repeat matches the surface
    // size, so panel/grime detail keeps a consistent real-world scale
    const texMat = (tex, color, rough, rx, ry) => {
      const t = tex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
      return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, map: t });
    };
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x4a5258, roughness: 0.45, metalness: 0.6 });
    const enclosed = mission.skybox === 'interior';

    // pass 1: roll every room's footprint up front, so a wall shared by two
    // differently-sized rooms can be built once at the wider span
    const dims = mission.segments.map((seg) => {
      const base = SIZE[seg.size] || SIZE.m;
      return {
        w: Math.round(base.w * (0.85 + Math.random() * 0.4)),
        d: Math.round(base.d * (0.85 + Math.random() * 0.4)),
        h: seg.size === 'l' ? 7.5 : seg.size === 's' ? 5 : 6,
      };
    });

    let zCursor = 0;
    mission.segments.forEach((seg, i) => {
      const sz = dims[i];
      const cz = zCursor + sz.d / 2;
      const room = { seg, index: i, cx: 0, cz, w: sz.w, d: sz.d,
        zFront: zCursor, zBack: zCursor + sz.d, enemies: [], spawned: false,
        reactorDone: seg.event !== 'reactor' ? true : false,
        bossDead: seg.event !== 'boss', cleared: false };

      const floorMat = texMat(floorTex, mission.palette.floor, 0.92, sz.w / 4, sz.d / 4);
      const wallMat = texMat(wallTex, mission.palette.wall, 0.8, (sz.w + sz.d) / 8, sz.h / 4);

      // The finale's drive segment is an OPEN track over the void, not a room:
      // keep only the boss-arena's back wall (its door, built as this segment's
      // front pass), then lay the winding road out into the collapsing Aureole.
      if (seg.event === 'vehicle-escape') {
        if (i > 0) this._wallWithGap(wallMat, zCursor, Math.max(sz.w, dims[i - 1].w), Math.max(sz.h, dims[i - 1].h), physics);
        this._buildEscapeTrack(room, zCursor, mission, physics, accent);
        this.segments.push(room);
        zCursor = room.zBack;
        return;
      }

      // floor (+ ceiling indoors)
      this._box(floorMat, 0, -0.5, cz, sz.w, 1, sz.d, physics, 'floor', true);
      if (enclosed) this._box(wallMat, 0, sz.h + 0.5, cz, sz.w, 1, sz.d, physics, 'ceil', false);

      // side walls
      this._box(wallMat, -sz.w / 2, sz.h / 2, cz, 1, sz.h, sz.d, physics, 'wall', true);
      this._box(wallMat, sz.w / 2, sz.h / 2, cz, 1, sz.h, sz.d, physics, 'wall', true);

      // front boundary: solid for room 0; otherwise one doorway wall spanning
      // the wider/taller of the two adjoining rooms (built once, here)
      if (i === 0) {
        this._box(wallMat, 0, sz.h / 2, zCursor, sz.w, sz.h, 1, physics, 'wall', true);
      } else {
        this._wallWithGap(wallMat, zCursor, Math.max(sz.w, dims[i - 1].w), Math.max(sz.h, dims[i - 1].h), physics);
      }

      // back: a lockable door panel (the doorway wall itself is built by the
      // next room's front pass); final room gets a solid wall or the escape gap
      const isLast = i === mission.segments.length - 1;
      if (!isLast) {
        const bh = Math.max(sz.h, dims[i + 1].h);
        const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, bh - 0.4, 0.4),
          new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25, transparent: true, opacity: 0.85 }));
        doorMesh.position.set(0, (bh - 0.4) / 2, room.zBack);
        this.group.add(doorMesh);
        physics.addBox({ x: 0, y: bh / 2, z: room.zBack }, { x: DOOR_W, y: bh, z: 0.4 }, 'door');
        room.door = { mesh: doorMesh, collider: physics.colliders[physics.colliders.length - 1] };
      } else if (seg.event === 'vehicle-escape') {
        // exit gap + glowing escape marker
        this._wallWithGap(wallMat, room.zBack, sz.w, sz.h, physics);
        const exit = AssetFactory.prop('ringArch', accent.getHex());
        exit.position.set(0, 0, room.zBack - 1); exit.rotation.z = 0;
        this.group.add(exit);
        room.exitZone = { z: room.zBack - 1.5, x: 0, r: 4 };
      } else {
        this._box(wallMat, 0, sz.h / 2, room.zBack, sz.w, sz.h, 1, physics, 'wall', true);
      }

      // ---- dressing: light strips, fill light, pipes, trim, ceiling beams ----
      const lightColor = i % 2 === 1 ? new THREE.Color(0xffe2bb) : accent;
      for (const sx of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, sz.d * 0.55),
          new THREE.MeshStandardMaterial({ color: 0x101418, emissive: lightColor, emissiveIntensity: 1.8, roughness: 0.4 }));
        strip.position.set(sx * (sz.w / 2 - 0.62), sz.h - 1.0, cz);
        this.group.add(strip);
        if (Math.random() < 0.8) {
          const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, sz.d * 0.85, 8), pipeMat);
          pipe.rotation.x = Math.PI / 2;
          pipe.position.set(sx * (sz.w / 2 - 0.4), 0.7 + Math.random() * 1.4, cz);
          this.group.add(pipe);
        }
        const trim = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, sz.d - 1),
          new THREE.MeshStandardMaterial({ color: 0x0c0f12, emissive: accent, emissiveIntensity: 0.9 }));
        trim.position.set(sx * (sz.w / 2 - 0.56), 0.05, cz);
        this.group.add(trim);
      }
      const fill = new THREE.PointLight(lightColor, 30, Math.max(sz.w, sz.d) * 1.5, 2);
      fill.position.set(0, sz.h - 1.2, cz);
      this.group.add(fill);
      if (enclosed) {
        for (let bz = zCursor + 3; bz < room.zBack - 2; bz += 5) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(sz.w - 0.5, 0.5, 0.45), wallMat);
          beam.position.set(0, sz.h - 0.25, bz);
          this.group.add(beam);
        }
      }

      // cover props
      const coverN = Math.round((seg.cover || 0) * (seg.size === 'l' ? 7 : 5));
      for (let c = 0; c < coverN; c++) {
        const kinds = ['crate', 'barrier', 'pillar'];
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        const prop = AssetFactory.prop(kind, new THREE.Color(mission.palette.accent).getHex());
        const px = (Math.random() - 0.5) * (sz.w - 4);
        const pz = cz + (Math.random() - 0.5) * (sz.d - 6);
        // never block a doorway lane — a prop at the front/back gap can wall the
        // player in, or stop the finale vehicle from driving out onto the track.
        if (Math.abs(px) < DOOR_W / 2 + 2.5 && (pz > room.zBack - 5 || pz < room.zFront + 5)) continue;
        const py = kind === 'pillar' ? 2 : (kind === 'crate' ? 0.6 : 0.5);
        prop.position.set(px, py, pz);
        this.group.add(prop);
        const size = kind === 'pillar' ? { x: 1.2, y: 4, z: 1.2 } : (kind === 'crate' ? { x: 1.2, y: 1.2, z: 1.2 } : { x: 2.2, y: 1, z: 0.5 });
        physics.addBox({ x: px, y: py, z: pz }, size, 'cover');
      }

      // reactor console (interact-to-activate objective). Boss rooms clear by
      // defeating the boss alone — no console required (avoids a finale soft-lock).
      if (seg.event === 'reactor') {
        const con = AssetFactory.prop('console', new THREE.Color(mission.palette.accent).getHex());
        con.position.set((Math.random() - 0.5) * (sz.w - 8), 0, room.zBack - 3);
        this.group.add(con);
        room.console = con;
        this.consoles.push({ room, pos: con.position.clone(), done: false });
      }

      // pickups
      (seg.pickups || []).forEach((pk, idx) => {
        const mesh = AssetFactory.pickup(pk.type, pk.weapon);
        const px = (Math.random() - 0.5) * (sz.w - 6);
        const pz = cz + (Math.random() - 0.5) * (sz.d - 8);
        mesh.position.set(px, 1.0, pz);
        this.group.add(mesh);
        this.pickups.push({ mesh, type: pk.type, weapon: pk.weapon, pos: mesh.position.clone(), taken: false, room });
      });

      this.segments.push(room);
      zCursor = room.zBack;
    });

    return { x: 0, y: 0.1, z: 3, yaw: 0 };
  }

  // The finale escape road: a guardrail-less winding chain of platform tiles
  // suspended over the void, threading through the collapsing Aureole and ending
  // at the lost Vanguard frigate. AABB tiles overlap so the surface stays
  // continuous; the meander keeps each step's lateral shift under a half-tile.
  _buildEscapeTrack(room, zStart, mission, physics, accent) {
    const STEP = 8, N = 42, TW = 16, TD = 14, THICK = 0.9;
    const tileMat = new THREE.MeshStandardMaterial({ color: 0x2c2742, roughness: 0.95, metalness: 0.12 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x0a0a12, emissive: accent, emissiveIntensity: 1.5 });

    // The road is FLAT (y=0). AABB tiles at different heights would act as
    // step-walls the arcade vehicle can't climb (it has no step-up), blocking the
    // drive — so the drama comes from the meander and the void, not elevation.
    const pts = [];
    let z = zStart + 6;
    for (let i = 0; i < N; i++) {
      const tail = Math.max(0, i - (N - 4)) / 4;            // straighten into the ship over the final tiles
      const ph = i * 0.24;
      const x = (1 - tail) * (Math.sin(ph) * 16 + Math.sin(ph * 0.46) * 9); // gentle meander; wind(0)=0 lines up with the door
      this._box(tileMat, x, -THICK / 2, z, TW, THICK, TD, physics, 'floor', true);
      for (const sx of [-1, 1]) {                            // glowing edge rims so the lip is readable in the dark
        const rim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, TD), rimMat);
        rim.position.set(x + sx * (TW / 2 - 0.15), 0.15, z);
        this.group.add(rim);
      }
      pts.push({ x, y: 0, z });
      z += STEP;
    }
    const end = pts[pts.length - 1];

    // Vast Aureole rings the road threads cleanly THROUGH — centred on the path
    // and facing down it, so you pass through the open hole, not the structure
    // (the tube stays far off the road). Decorative; the on-road walls below are
    // the things you actually steer around.
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6b7a92, metalness: 0.3, roughness: 0.6, emissive: 0x223347, emissiveIntensity: 0.4 });
    [6, 17, 28, 38].forEach((i, r) => {
      const p = pts[Math.min(N - 1, i)];
      const ring = new THREE.Mesh(new THREE.TorusGeometry(26 + r * 7, 2.6, 8, 44), ringMat);
      ring.position.set(p.x, 9, p.z + 4);
      ring.rotation.set(0.12, 0, r % 2 ? 0.18 : -0.18); // hole faces +Z (down the road), slight tilt
      this.group.add(ring);
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(150, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x36284f, roughness: 1, emissive: 0x140e22, emissiveIntensity: 0.6 }));
    planet.position.set(150, -190, zStart + 200);
    this.group.add(planet);
    for (let d = 0; d < 26; d++) {
      const p = pts[(d * 7) % N];
      const s = 1 + (d % 5);
      const chunk = new THREE.Mesh(new THREE.BoxGeometry(s, 1 + (d % 3), s * 0.8), tileMat);
      chunk.position.set(p.x + ((d % 7) - 3) * 7, p.y - 5 - (d % 6) * 4, p.z + ((d % 5) - 2) * 5);
      chunk.rotation.set(d * 0.7, d * 1.3, d * 0.5);
      this.group.add(chunk);
    }
    for (let i = 4; i < N; i += 8) {
      const p = pts[i];
      const l = new THREE.PointLight(accent.getHex(), 14, 30, 2);
      l.position.set(p.x, p.y + 4, p.z); this.group.add(l);
    }

    // Ring-debris fallen across the road: SOLID walls (AABB) that block the
    // centreline but leave a clear lane to one side. They alternate sides, so you
    // slalom. Stored on the room so the drivability check can weave too.
    room.obstacles = [];
    const obsMat = new THREE.MeshStandardMaterial({ color: 0x46415e, roughness: 0.85, metalness: 0.2 });
    [9, 14, 19, 24, 29, 34].forEach((i, k) => {
      if (i >= N) return;
      const p = pts[i];
      const side = k % 2 ? 1 : -1;
      const ox = p.x + side * 3.6, oz = p.z, W = 6, H = 5.5, D = 3.4;
      const block = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), obsMat);
      block.position.set(ox, H / 2 - 0.3, oz); block.rotation.y = side * 0.18;
      const arc = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.55, 6, 12, Math.PI * 1.2),
        new THREE.MeshStandardMaterial({ color: 0x6b7a92, metalness: 0.4, roughness: 0.5, emissive: accent, emissiveIntensity: 0.35 }));
      arc.position.set(ox, H - 0.2, oz); arc.rotation.set(Math.PI / 2, 0, side * 0.4);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 0.45, D + 0.3),
        new THREE.MeshStandardMaterial({ color: 0x0a0a12, emissive: accent, emissiveIntensity: 1.8 }));
      stripe.position.set(ox, 0.55, oz);
      this.group.add(block, arc, stripe);
      physics.addBox({ x: ox, y: H / 2, z: oz }, { x: W, y: H, z: D }, 'wall');
      room.obstacles.push({ z: oz, blockMinX: ox - W / 2 - 1.6, blockMaxX: ox + W / 2 + 1.6, clearX: p.x - side * 5.5 });
    });

    // the Vanguard frigate at the end — drive into its hangar to win
    const ship = AssetFactory.vanguardShip();
    ship.position.set(end.x, end.y, end.z + 13);
    this.group.add(ship);

    room.shipZone = { x: end.x, z: end.z + 2, halfW: 5 }; // win on crossing into the hangar mouth
    room.trackBaseY = 0;                                   // flat road; fall below this (-9) -> the void
    room.zBack = end.z + 26;
    room.trackSpawnPoints = pts;                           // used to scatter Wobble along the road
  }

  _box(mat, x, y, z, w, h, d, physics, tag, collide) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.receiveShadow = true; m.castShadow = tag === 'wall';
    this.group.add(m);
    if (collide) physics.addBox({ x, y, z }, { x: w, y: h, z: d }, tag);
    return m;
  }

  _wallWithGap(mat, z, w, h, physics) {
    const side = (w - DOOR_W) / 2;
    const lx = -(DOOR_W / 2 + side / 2);
    const rx = (DOOR_W / 2 + side / 2);
    this._box(mat, lx, h / 2, z, side, h, 1, physics, 'wall', true);
    this._box(mat, rx, h / 2, z, side, h, 1, physics, 'wall', true);
    // lintel above the doorway
    this._box(mat, 0, h - 0.5, z, DOOR_W, 1, 1, physics, 'wall', false);
  }

  start(ctx, fromSegment = 0) {
    // When resuming from a checkpoint, pre-clear and open the rooms before it.
    for (let i = 0; i < fromSegment && i < this.segments.length; i++) {
      const r = this.segments[i];
      r.cleared = true; r.spawned = true; r.reactorDone = true; r.bossDead = true;
      this.consoles.filter((c) => c.room === r).forEach((c) => { c.done = true; });
      this._forceOpenDoor(r);
    }
    this._activate(Math.min(fromSegment, this.segments.length - 1), ctx);
  }

  // Player spawn at the start of a given segment (for checkpoint resume).
  segmentSpawn(i) {
    const r = this.segments[i] || this.segments[0];
    return { x: 0, y: 0.1, z: r.zFront + 3, yaw: 0 };
  }

  _forceOpenDoor(room) {
    if (!room.door) return;
    const idx = this.physics.colliders.indexOf(room.door.collider);
    if (idx >= 0) this.physics.colliders.splice(idx, 1);
    room.door.mesh.visible = false;
  }

  _activate(i, ctx) {
    if (i >= this.segments.length) { this._win(ctx); return; }
    this.activeIndex = i;
    const room = this.segments[i];
    ctx.onObjective && ctx.onObjective(room.seg.objectiveText);
    if (this._dialogueQueuedFor !== i) {
      this._dialogueQueuedFor = i;
      ctx.onDialogue && ctx.onDialogue(room.seg.dialogue || []);
    }
    this._spawnRoom(room, ctx);
    if (room.seg.event === 'vehicle-escape') {
      this.inEscape = true;
      this.escapeTime = 42;       // beat the collapsing ring to the Vanguard
      this.physics.floorY = -300; // open the void: drive off the road and you fall
      ctx.onMountVehicle && ctx.onMountVehicle();
      // co-op declares per-role banners (driver vs gunner) from _mountVehicle; solo gets the generic one
      if (!(ctx._g && ctx._g.coopRole)) ctx.onBanner && ctx.onBanner('DRIVE', 'No guardrails, no time. Reach the Vanguard — Fire / right-click the turret.', 2.6);
    }
    ctx.audio && ctx.audio.sfx('objective');
  }

  _spawnRoom(room, ctx) {
    if (room.spawned) return;
    room.spawned = true;
    // Escape track: scatter the Wobble ALONG the road as turret targets. Hover
    // types float beside the lip; grounded types ride the tiles.
    if (room.seg.event === 'vehicle-escape' && room.trackSpawnPoints) {
      const pts = room.trackSpawnPoints;
      const first = 5, last = pts.length - 3, span = Math.max(1, last - first);
      for (const grp of room.seg.enemies) {
        // air types hold station as hovering targets beside the lip; ground
        // types ride the road centreline so you can drive straight over them.
        const air = grp.type === 'floater' || grp.type === 'wobbler';
        for (let n = 0; n < grp.count; n++) {
          const f = grp.count > 1 ? n / (grp.count - 1) : 0.5;          // spread the group along the road
          const p = pts[Math.round(first + f * span)];
          if (air) {
            const off = ((n % 2) ? 1 : -1) * (3 + Math.random() * 5);
            const e = ctx.spawnEnemy(grp.type, new THREE.Vector3(p.x + off, p.y + 3.0 + Math.random() * 2, p.z));
            e.hover = true;
            room.enemies.push(e);
          } else {
            const e = ctx.spawnEnemy(grp.type, new THREE.Vector3(p.x + (Math.random() - 0.5) * 8, p.y + 0.3, p.z + (Math.random() - 0.5) * 6));
            room.enemies.push(e);
          }
        }
      }
      return;
    }
    const sz = { w: room.w, d: room.d };
    for (const grp of room.seg.enemies) {
      for (let n = 0; n < grp.count; n++) {
        const ex = (Math.random() - 0.5) * (sz.w - 4);
        const ez = room.cz + (Math.random() - 0.2) * (sz.d - 6) * 0.5 + sz.d * 0.15;
        const e = ctx.spawnEnemy(grp.type, new THREE.Vector3(ex, grp.type === 'floater' ? 2.2 : 0.1, ez));
        room.enemies.push(e);
        if (grp.type === 'boss') room.boss = e;
      }
    }
  }

  update(dt, player, ctx) {
    if (this.complete || this.failed) return;

    // animate pickups + try collection
    for (const p of this.pickups) {
      if (p.taken) continue;
      p.mesh.rotation.y += dt * 1.5;
      if (p.mesh.userData.spin) p.mesh.userData.spin.rotation.x += dt * 2;
      if (player.pos.distanceTo(p.pos) < 1.6) this._collect(p, player, ctx);
    }

    const room = this.segments[this.activeIndex];
    if (!room) return;
    this._containRoom(room, dt, player, ctx); // keep enemies in-bounds & reachable (anti-soft-lock)

    // reactor / boss console interaction
    let promptText = null;
    const con = this.consoles.find((c) => c.room === room && !c.done);
    if (con) {
      const near = player.pos.distanceTo(con.pos) < 3.0;
      const enemiesLeft = room.enemies.filter((e) => !e.dead).length;
      if (near) {
        if (enemiesLeft > 0 && room.seg.event === 'reactor') promptText = 'Clear the area first';
        else promptText = '[Interact] Activate console';
        if (ctx.interactPressed && (enemiesLeft === 0 || room.seg.event === 'boss')) {
          con.done = true; room.reactorDone = true;
          ctx.audio && ctx.audio.sfx('objective');
          ctx.onBanner && ctx.onBanner('SYSTEM ONLINE', '', 1.2);
        }
      }
    }
    ctx.setPrompt && ctx.setPrompt(promptText);

    // boss death tracking
    if (room.boss) room.bossDead = room.boss.dead;

    // escape: race the clock; fall off the open road -> death; reach the
    // Vanguard hangar -> win; let the timer hit zero -> the ring takes you.
    if (this.inEscape && this.activeIndex === this.segments.length - 1) {
      this.escapeTime -= dt;
      ctx.onEscape && ctx.onEscape(Math.max(0, this.escapeTime));
      if (player.pos.y < (room.trackBaseY != null ? room.trackBaseY : -3) - 9) {
        this._fail(ctx, 'You drove off the edge of the Aureole and into the dark.'); return;
      }
      const sz = room.shipZone;
      if (sz && player.pos.z > sz.z && Math.abs(player.pos.x - sz.x) < sz.halfW) { this._win(ctx); return; }
      if (this.escapeTime <= 0) { this._fail(ctx, 'Too slow. The Aureole fired and took the ring — and you — with it.'); return; }
    }

    // clear check (skipped in freeplay modes — Tutorial/Survival own their flow and
    // the empty/looping arena would otherwise "clear" and end the mission instantly)
    if (!room.cleared && !this.freeplay) {
      const enemiesLeft = room.enemies.filter((e) => !e.dead).length;
      const objectivesDone = room.reactorDone && room.bossDead;
      // A boss room is cleared by defeating the boss alone. The boss spawns adds
      // faster than they can always be mopped up, and a stray add can wander out
      // of reach — neither should soft-lock the finale's drive segment. Ordinary
      // rooms still require a full sweep.
      const cleared = room.seg.event === 'boss' ? room.bossDead : (enemiesLeft === 0 && objectivesDone);
      if (cleared) {
        room.cleared = true;
        this._openDoor(room, ctx);
        // last non-escape room with no door = win on clear
        if (this.activeIndex >= this.segments.length - 1 && !this.inEscape) { this._win(ctx); return; }
        if (!this.inEscape) {
          ctx.onCheckpoint && ctx.onCheckpoint(this.activeIndex + 1);
          this._activate(this.activeIndex + 1, ctx);
        }
      }
    }

    // failsafe: if a non-escape active room is cleared but advance stalled
  }

  // Keep the active room's enemies reachable. Knockback, the enemy-vs-enemy
  // separation shove, or a summon that lands in a wall can put an enemy outside
  // the room — and since a room only clears when EVERY enemy is dead, a single
  // unreachable straggler soft-locks progress. Each frame we pull stragglers back
  // inside the walls; as a guaranteed last resort, if no damage has landed on any
  // survivor for a sustained stretch (they're genuinely unreachable), we neutralise
  // them so the door can open. The open escape track and boss rooms are exempt.
  _containRoom(room, dt, player, ctx) {
    if (!room || room.seg.event === 'vehicle-escape') return;
    const hw = room.w / 2;
    let aliveCount = 0, aliveHp = 0;
    for (const e of room.enemies) {
      if (e.dead) continue;
      aliveCount++; aliveHp += (e.hp || 0) + (e.shield || 0);
      if (e.type === 'boss') continue;                 // the boss owns its (large) arena
      const m = (e.radius || 0.6) + 0.6;
      let moved = false;
      // Only correct enemies still inside the active room. The FRONT doorway is
      // open to the (cleared) prior room, so let an enemy chase the player back
      // through it — clamping the front edge would strand it at the threshold and
      // it could never reach a player who retreats. Side + back walls are solid.
      if (e.pos.z >= room.zFront) {
        const xMin = room.cx - hw + m, xMax = room.cx + hw - m;
        if (e.pos.x < xMin) { e.pos.x = xMin; e.vel && (e.vel.x = 0); moved = true; }
        else if (e.pos.x > xMax) { e.pos.x = xMax; e.vel && (e.vel.x = 0); moved = true; }
        const zMax = room.zBack - m;                   // back is the locked door — keep them off it
        if (e.pos.z > zMax) { e.pos.z = zMax; e.vel && (e.vel.z = 0); moved = true; }
      }
      if (!e.hover && (e.pos.y < 0 || e.pos.y > 30)) { e.pos.y = 0.1; e.vel && e.vel.set(0, 0, 0); moved = true; }
      if (moved && e.mesh) e.mesh.position.copy(e.pos);
    }

    // Soft-lock failsafe (boss rooms clear by defeat, so they're exempt).
    if (room.seg.event === 'boss' || aliveCount === 0) { room._stuckT = 0; room._lastHp = aliveHp; room._lastAlive = aliveCount; return; }
    const progressed = aliveCount < (room._lastAlive ?? Infinity) || aliveHp < (room._lastHp ?? Infinity) - 0.01;
    room._stuckT = progressed ? 0 : (room._stuckT || 0) + dt;
    room._lastAlive = aliveCount; room._lastHp = aliveHp;
    if (room._stuckT > 30) {
      room._stuckT = 0;
      for (const e of room.enemies) { if (!e.dead && e.type !== 'boss') { e._noSiphon = true; e.takeDamage(1e9, { source: player.pos }); } } // engine cleanup, not a player kill
      ctx.onBanner && ctx.onBanner('AREA SECURED', 'IRIS purged a straggler that slipped the geometry.', 1.8);
    }
  }

  _collect(p, player, ctx) {
    p.taken = true;
    p.mesh.visible = false;
    ctx.audio && ctx.audio.sfx('pickup');
    // Each pickup announces what it did, so the floating diamonds aren't a mystery:
    // red = health, gold = ammo, cyan = a weapon.
    if (p.type === 'health') { player.addHealth(25); ctx.onBanner && ctx.onBanner('+25 HEALTH', '', 0.9); }
    else if (p.type === 'ammo') { player.weapons.forEach((w) => w.addReserve(w.def.magazine)); ctx.onBanner && ctx.onBanner('AMMO RESTOCKED', '', 0.9); }
    else if (p.type === 'weapon' && p.weapon) { player.giveWeapon(p.weapon); ctx.onBanner && ctx.onBanner('PICKED UP', p.weapon.toUpperCase(), 1.0); }
    ctx.onPickup && ctx.onPickup(p);
  }

  _openDoor(room, ctx) {
    if (!room.door) return;
    const idx = this.physics.colliders.indexOf(room.door.collider);
    if (idx >= 0) this.physics.colliders.splice(idx, 1);
    // slide the door up out of the way
    room.door.opening = true;
    const mesh = room.door.mesh;
    const tick = () => {
      mesh.position.y += 0.18;
      if (mesh.position.y < 10) requestAnimationFrame(tick); // clear of any room height
      else mesh.visible = false;
    };
    tick();
    ctx.audio && ctx.audio.sfx('ui');
    ctx.onObjective && ctx.onObjective('Advance');
  }

  _win(ctx) { if (this.complete || this.failed) return; this.complete = true; ctx.onMissionComplete && ctx.onMissionComplete(); }
  _fail(ctx, reason) { if (this.complete || this.failed) return; this.failed = true; ctx.onFail && ctx.onFail(reason); }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.map) m.map.dispose(); // per-room texture clones hold GPU memory
          m.dispose && m.dispose();
        });
      }
    });
  }
}
