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
      this.escapeTime = 40;
      ctx.onMountVehicle && ctx.onMountVehicle();
      ctx.onBanner && ctx.onBanner('DRIVE', 'Floor it to the tear before the Aureole fires', 1.8);
    }
    ctx.audio && ctx.audio.sfx('objective');
  }

  _spawnRoom(room, ctx) {
    if (room.spawned) return;
    room.spawned = true;
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

    // vehicle-escape countdown + exit
    if (this.inEscape && this.activeIndex === this.segments.length - 1) {
      this.escapeTime -= dt;
      ctx.onEscape && ctx.onEscape(Math.max(0, this.escapeTime));
      if (room.exitZone && Math.abs(player.pos.x - room.exitZone.x) < room.exitZone.r && player.pos.z > room.exitZone.z - room.exitZone.r) {
        this._win(ctx); return;
      }
      if (this.escapeTime <= 0) { this._fail(ctx, 'The Aureole fired. There was no other side of the gap.'); return; }
    }

    // clear check
    if (!room.cleared) {
      const enemiesLeft = room.enemies.filter((e) => !e.dead).length;
      const objectivesDone = room.reactorDone && room.bossDead;
      if (enemiesLeft === 0 && objectivesDone) {
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

  _collect(p, player, ctx) {
    p.taken = true;
    p.mesh.visible = false;
    ctx.audio && ctx.audio.sfx('pickup');
    if (p.type === 'health') player.addHealth(25);
    else if (p.type === 'ammo') { player.weapons.forEach((w) => w.addReserve(w.def.magazine)); }
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
