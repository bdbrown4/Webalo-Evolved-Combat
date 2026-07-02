// AssetFactory.js — every visible mesh is built here from primitives. No model
// files, no textures. The Wobble Coalition aliens are deliberately goofy:
// round bodies, oversized googly eyes, stubby limbs, jaunty antennae.

import * as THREE from 'three';

const _enemyTemplates = new Map();   // enemy type -> template Group (clone per spawn)
const _projCache = new Map();        // projectile type -> { geo, mat, cloneMat }
let _muzzleGeo = null;               // shared muzzle-flash sphere

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
  color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0.05,
  emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  flatShading: opts.flat ?? false, transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
});

function googlyEye(radius) {
  const g = new THREE.Group();
  const white = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12), mat(0xffffff, { rough: 0.3 }));
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.5, 10, 10), mat(0x111111, { rough: 0.2 }));
  pupil.position.z = radius * 0.7;
  g.add(white, pupil);
  return g;
}

// First-person arms for the weapon view-models: an armored sleeve + glove on
// the grip, and a support hand under the fore-end for two-handed weapons.
function viewArms(g, twoHanded) {
  const sleeveM = mat(0x3a4030, { rough: 0.9 });
  const gloveM = mat(0x23261e, { rough: 0.8 });
  const ra = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.34, 4, 8), sleeveM);
  ra.position.set(0.04, -0.34, 0.34); ra.rotation.x = 1.0; ra.rotation.z = -0.15;
  const rh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), gloveM);
  rh.scale.set(1, 0.85, 1.2); rh.position.set(0, -0.17, 0.17);
  g.add(ra, rh);
  if (twoHanded) {
    const la = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 8), sleeveM);
    la.position.set(0.18, -0.3, 0.02); la.rotation.x = 0.9; la.rotation.z = 0.5;
    const lh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), gloveM);
    lh.scale.set(1.1, 0.8, 1.2); lh.position.set(0.03, -0.08, -0.14);
    g.add(la, lh);
  }
}

export const AssetFactory = {
  // ---------- Player view-model weapons (rendered in a separate overlay scene) ----------
  weaponViewModel(key) {
    const g = new THREE.Group();
    const colors = {
      pistol: 0x8a8f96, rifle: 0x3a4046, goocaster: 0x6cd06c,
      stinger: 0xff7fd0, boomstick: 0x7a4a2a,
    };
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.5), mat(colors[key] || 0x888888, { metal: 0.4, rough: 0.5 }));
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.14), mat(0x222428, { rough: 0.7 }));
    grip.position.set(0, -0.16, 0.16);
    grip.rotation.x = 0.3;
    g.add(body, grip);
    if (key === 'pistol') { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), mat(0x6a6f76, { metal: 0.6 })); bar.position.set(0, 0.06, -0.18); g.add(bar); }
    if (key === 'rifle') { const mag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.1), mat(0x222428)); mag.position.set(0, -0.18, -0.02); g.add(mag); const scope = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.2), mat(0x111)); scope.position.set(0, 0.13, 0); g.add(scope); }
    if (key === 'goocaster') { const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), mat(0x2a6a2a, { emissive: 0x39ff39, emissiveIntensity: 0.8 })); bulb.position.set(0, 0.02, -0.26); g.add(bulb); }
    if (key === 'stinger') { for (let i = 0; i < 5; i++) { const spike = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.12, 6), mat(0xff7fd0, { emissive: 0xff3fb0, emissiveIntensity: 0.6 })); spike.position.set(-0.06 + i * 0.03, 0.12, -0.1); g.add(spike); } }
    if (key === 'boomstick') { const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 10), mat(0x4a4f55, { metal: 0.6 })); b2.rotation.x = Math.PI / 2; b2.position.set(0.05, 0.02, -0.16); const b3 = b2.clone(); b3.position.x = -0.05; g.add(b2, b3); }
    viewArms(g, key !== 'pistol');
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    return g;
  },

  // First-person gloved fist, shown for a quick jab on the melee action.
  fistViewModel() {
    const g = new THREE.Group();
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 8), mat(0x3a4030, { rough: 0.9 }));
    sleeve.rotation.x = Math.PI / 2; sleeve.position.set(0, -0.01, 0.24);
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.15, 0.12), mat(0x23261e, { rough: 0.8 }));
    wrist.position.set(0, 0, 0.02);
    const knuckles = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.13, 0.1), mat(0x2b2f24, { rough: 0.75 }));
    knuckles.position.set(0, 0.005, -0.08);
    g.add(sleeve, wrist, knuckles);
    for (let i = 0; i < 4; i++) {
      const kn = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), mat(0x33372a, { rough: 0.7 }));
      kn.position.set(-0.066 + i * 0.044, 0.04, -0.13);
      g.add(kn);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    return g;
  },

  // First-person grenade hand, shown while a grenade is primed ("cooking").
  grenadeViewModel(sticky) {
    const g = new THREE.Group();
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.32, 4, 8), mat(0x3a4030, { rough: 0.9 }));
    sleeve.position.set(0.02, -0.24, 0.18); sleeve.rotation.x = 0.75;
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.078, 10, 8), mat(0x23261e, { rough: 0.8 }));
    glove.scale.set(1, 0.85, 1.15); glove.position.set(0, -0.03, 0);
    const nade = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 12),
      sticky ? mat(0x2a7a3a, { emissive: 0x39ff39, emissiveIntensity: 0.9 }) : mat(0x33502f, { rough: 0.6 }));
    nade.position.set(0, 0.06, 0);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.045, 8), mat(0x8a8f96, { metal: 0.6 }));
    cap.position.set(0, 0.155, 0);
    g.add(sleeve, glove, nade, cap);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    return g;
  },

  // ---------- Wobble Coalition aliens ----------
  // Enemies spawn constantly (Survival waves), so each type is built ONCE as a
  // template and spawns are clones: geometries + most materials are shared (no
  // per-spawn buffer uploads / shader compiles). Only the handful of materials
  // that animate per-instance (hit flash, fuse pulse, plate glint, shield
  // bubble) are cloned. Special part references can't ride userData through
  // clone(), so parts are tagged by NAME and rebound here.
  enemy(type) {
    let tpl = _enemyTemplates.get(type);
    if (!tpl) { tpl = this._buildEnemy(type); _enemyTemplates.set(type, tpl); }
    const g = tpl.clone();
    g.userData = { standHeight: tpl.userData.standHeight };
    for (const key of ['body', 'antennaBulb', 'hoverRing', 'popCore', 'plate', 'shieldBubble']) {
      const node = g.getObjectByName('ud_' + key);
      if (!node) continue;
      g.userData[key] = node;
      if (node.material && key !== 'antennaBulb' && key !== 'hoverRing') node.material = node.material.clone();
    }
    return g;
  },

  _buildEnemy(type) {
    const g = new THREE.Group();
    const cfg = {
      blork:   { color: 0xff8a3d, size: 0.45, eye: 0.12, antenna: true,  feet: true },
      gurg:    { color: 0x7d57c9, size: 0.85, eye: 0.16, antenna: false, feet: true,  bulky: true },
      wobbler: { color: 0x35c98f, size: 0.9,  eye: 0.18, antenna: true,  feet: true,  tall: true },
      floater: { color: 0xe8d24a, size: 0.4,  eye: 0.22, antenna: false, feet: false, hover: true },
      boss:    { color: 0xd83a6a, size: 1.8,  eye: 0.3,  antenna: true,  feet: true,  bulky: true },
      sprocket:{ color: 0x2ec4b6, size: 1.3,  eye: 0.2,  antenna: false, feet: true,  tall: true },
      popper:  { color: 0xff5a3d, size: 0.5,  eye: 0.14, antenna: false, feet: true,  core: true },
      medic:   { color: 0x7cfc9a, size: 0.5,  eye: 0.16, antenna: true,  feet: false, hover: true, cross: true },
      bulwark: { color: 0x9aa7b3, size: 0.95, eye: 0.16, antenna: false, feet: true,  bulky: true, plate: true },
      blinker: { color: 0xc77dff, size: 0.44, eye: 0.2,  antenna: true,  feet: false, hover: true, wisp: true },
    }[type] || { color: 0xff8a3d, size: 0.5, eye: 0.12, antenna: true, feet: true };

    const s = cfg.size;
    const bodyGeo = cfg.tall
      ? new THREE.CapsuleGeometry(s * 0.6, s * 0.9, 6, 12)
      : new THREE.SphereGeometry(s, 16, 14);
    const body = new THREE.Mesh(bodyGeo, mat(cfg.color, { rough: 0.5, flat: false }));
    body.scale.y = cfg.tall ? 1 : (cfg.bulky ? 0.85 : 1.05);
    body.position.y = cfg.hover ? s * 1.6 : s * (cfg.tall ? 1.4 : 1.0);
    body.name = 'ud_body';
    g.add(body);

    // googly eyes
    const eL = googlyEye(cfg.eye), eR = googlyEye(cfg.eye);
    const eyY = body.position.y + s * 0.15, eyZ = s * 0.85, eyX = s * 0.32;
    eL.position.set(-eyX, eyY, eyZ); eR.position.set(eyX, eyY, eyZ);
    g.add(eL, eR);

    if (cfg.antenna) {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.04, s * 0.04, s * 0.7, 6), mat(0x333));
      stalk.position.set(0, body.position.y + s * 0.9, 0);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(s * 0.12, 8, 8), mat(cfg.color, { emissive: cfg.color, emissiveIntensity: 0.7 }));
      bulb.position.set(0, body.position.y + s * 1.25, 0);
      bulb.name = 'ud_antennaBulb';
      g.add(stalk, bulb);
    }
    if (cfg.feet) {
      for (const sx of [-1, 1]) {
        const foot = new THREE.Mesh(new THREE.SphereGeometry(s * 0.22, 8, 8), mat(0x2a2a2a));
        foot.scale.set(1, 0.6, 1.3);
        foot.position.set(sx * s * 0.4, s * 0.18, 0.1);
        g.add(foot);
      }
    }
    if (cfg.hover) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(s * 0.9, s * 0.12, 8, 18), mat(0x444, { metal: 0.5 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = s * 1.1;
      ring.name = 'ud_hoverRing';
      g.add(ring);
    }
    if (cfg.bulky) {
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(s * 0.18, s * 0.5, 4, 8), mat(cfg.color, { rough: 0.5 }));
        arm.position.set(sx * s * 0.95, body.position.y, 0); arm.rotation.z = sx * 0.4;
        g.add(arm);
      }
    }
    // Quivermaster Sprocket — a unique mini-boss: a crown of quills, a row of
    // extra googly eyes, and a clanking sprocket-gear belt. Theatrical, like a
    // discount Pomplemoose.
    if (type === 'sprocket') {
      for (let i = -2; i <= 2; i++) {                     // crown of quills
        const a = i * 0.34;
        const stalk = new THREE.Mesh(new THREE.ConeGeometry(s * 0.06, s * 0.95, 6), mat(0x222));
        stalk.position.set(Math.sin(a) * s * 0.55, body.position.y + s * 1.05, 0);
        stalk.rotation.z = -a;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(s * 0.1, 8, 8), mat(cfg.color, { emissive: cfg.color, emissiveIntensity: 1.0 }));
        tip.position.set(Math.sin(a) * s * 0.95, body.position.y + s * 1.52, 0);
        g.add(stalk, tip);
      }
      for (const ex of [-0.62, -0.21, 0.21, 0.62]) {       // a row of extra eyes
        const e = googlyEye(cfg.eye * 0.7);
        e.position.set(ex * s, body.position.y + s * 0.42, s * 0.78);
        g.add(e);
      }
      const gear = new THREE.Mesh(new THREE.TorusGeometry(s * 1.0, s * 0.13, 6, 14), mat(0x9a8638, { metal: 0.6, rough: 0.4 }));
      gear.rotation.x = Math.PI / 2; gear.position.y = body.position.y - s * 0.35;
      g.add(gear);
      for (let t = 0; t < 8; t++) {                        // gear teeth
        const ang = (t / 8) * Math.PI * 2;
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(s * 0.18, s * 0.14, s * 0.18), mat(0x9a8638, { metal: 0.6 }));
        tooth.position.set(Math.cos(ang) * s * 1.12, body.position.y - s * 0.35, Math.sin(ang) * s * 1.12);
        g.add(tooth);
      }
    }

    if (cfg.core) {            // popper: a volatile glowing core that flashes on its fuse
      const core = new THREE.Mesh(new THREE.SphereGeometry(s * 0.55, 12, 10),
        mat(0xffd24a, { emissive: 0xffaa33, emissiveIntensity: 0.8, transparent: true, opacity: 0.85 }));
      core.name = 'ud_popCore'; core.position.y = body.position.y; g.add(core);
    }
    if (cfg.cross) {           // medic: a glowing health cross
      const cm = mat(0xffffff, { emissive: 0xbfffd0, emissiveIntensity: 1.0 });
      const v = new THREE.Mesh(new THREE.BoxGeometry(s * 0.16, s * 0.5, s * 0.06), cm);
      const h = new THREE.Mesh(new THREE.BoxGeometry(s * 0.5, s * 0.16, s * 0.06), cm);
      v.position.set(0, body.position.y, s * 0.9); h.position.set(0, body.position.y, s * 0.9);
      g.add(v, h);
    }
    if (cfg.plate) {           // bulwark: a frontal shield plate (local +z = the unit's facing)
      const plate = new THREE.Mesh(new THREE.BoxGeometry(s * 1.9, s * 1.7, s * 0.18), mat(0x6f7b87, { metal: 0.5, rough: 0.4 }));
      plate.name = 'ud_plate'; plate.position.set(0, body.position.y, s * 1.05); g.add(plate);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(s * 0.82, s * 0.08, 6, 16), mat(cfg.color, { emissive: cfg.color, emissiveIntensity: 0.4 }));
      rim.position.set(0, body.position.y, s * 1.16); g.add(rim);
    }
    if (cfg.wisp) {            // blinker: a faint unstable aura
      const halo = new THREE.Mesh(new THREE.SphereGeometry(s * 1.2, 12, 10),
        mat(cfg.color, { transparent: true, opacity: 0.16, emissive: cfg.color, emissiveIntensity: 0.6 }));
      halo.position.y = body.position.y; g.add(halo);
    }

    // Shielded units carry a personal shield bubble (tinted to their colour)
    if (type === 'wobbler' || type === 'boss' || type === 'sprocket') {
      const bc = type === 'sprocket' ? cfg.color : 0x35c98f;
      const bub = new THREE.Mesh(new THREE.SphereGeometry(s * 1.35, 16, 12), mat(bc, { transparent: true, opacity: 0.18, emissive: bc, emissiveIntensity: 0.4 }));
      bub.position.y = body.position.y;
      bub.name = 'ud_shieldBubble'; g.add(bub);
    }

    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    g.userData.standHeight = body.position.y;
    return g;
  },

  // ---------- World props ----------
  prop(kind, accentColor = 0x5fd0e6) {
    switch (kind) {
      case 'crate': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), mat(0x6b5a3a, { rough: 0.9 }));
        m.castShadow = true; m.receiveShadow = true; return m;
      }
      case 'barrier': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 0.5), mat(0x44505a, { metal: 0.3 }));
        m.castShadow = true; m.receiveShadow = true; return m;
      }
      case 'pillar': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 4, 12), mat(0x9aa3ad, { rough: 0.6 }));
        m.castShadow = true; m.receiveShadow = true; return m;
      }
      case 'console': {
        const g = new THREE.Group();
        const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 0.8), mat(0x2a3640));
        const screen = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.06), mat(0x0a0a0a, { emissive: accentColor, emissiveIntensity: 0.7 }));
        screen.position.set(0, 0.7, 0.4); screen.rotation.x = -0.3;
        g.add(base, screen); g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
        return g;
      }
      case 'ringArch': {
        const m = new THREE.Mesh(new THREE.TorusGeometry(6, 0.6, 10, 28, Math.PI), mat(0xb9c4cf, { metal: 0.3, rough: 0.4 }));
        m.castShadow = true; return m;
      }
      default: return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(0x888888));
    }
  },

  pickup(type, weaponKey) {
    const g = new THREE.Group();
    const colors = { health: 0xff5a5a, ammo: 0xffd35a, weapon: 0x5fd0e6 };
    const c = colors[type] || 0xffffff;
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), mat(c, { emissive: c, emissiveIntensity: 0.8, metal: 0.2 }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 8, 20), mat(c, { emissive: c, emissiveIntensity: 0.5 }));
    ring.rotation.x = Math.PI / 2;
    g.add(core, ring);
    g.userData.spin = core;
    g.userData.glow = new THREE.PointLight(c, 0.8, 4); g.add(g.userData.glow);
    return g;
  },

  // Tileable grime/panel texture drawn to a canvas at runtime (no asset files).
  // Painted in neutral grays so the material's color tint sets the hue.
  surfaceTexture(kind) {
    const S = 256;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d');
    c.fillStyle = '#b8b8b8'; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 2000; i++) {
      const v = 120 + Math.floor(Math.random() * 90);
      c.fillStyle = `rgba(${v},${v},${v},0.16)`;
      c.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
    if (kind === 'floor') {
      // deck panels with seams and worn stains
      c.strokeStyle = 'rgba(0,0,0,0.30)'; c.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, S); c.stroke();
        c.beginPath(); c.moveTo(0, i * 64); c.lineTo(S, i * 64); c.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const x = Math.random() * S, y = Math.random() * S, r = 14 + Math.random() * 32;
        const grd = c.createRadialGradient(x, y, 2, x, y, r);
        grd.addColorStop(0, 'rgba(0,0,0,0.16)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = grd; c.fillRect(x - r, y - r, r * 2, r * 2);
      }
    } else {
      // wall plating: horizontal bands, offset vertical seams, rivets, grime
      c.strokeStyle = 'rgba(0,0,0,0.26)'; c.lineWidth = 2;
      for (let y = 0; y < S; y += 64) { c.beginPath(); c.moveTo(0, y + 32); c.lineTo(S, y + 32); c.stroke(); }
      c.fillStyle = 'rgba(0,0,0,0.28)';
      for (let row = 0; row < 4; row++) {
        const off = (row % 2) * 64;
        for (let x = off; x < S; x += 128) c.fillRect(x, row * 64, 2, 64);
      }
      c.fillStyle = 'rgba(255,255,255,0.10)';
      for (let row = 0; row < 4; row++) for (let x = 10; x < S; x += 36) {
        c.beginPath(); c.arc(x, row * 64 + 38, 1.6, 0, Math.PI * 2); c.fill();
      }
      const grd = c.createLinearGradient(0, S * 0.6, 0, S);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.24)');
      c.fillStyle = grd; c.fillRect(0, 0, S, S);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  },

  // gradient "skybox" via a large inverted sphere, plus stars / a low sun so
  // outdoor missions read as a real place instead of a flat gradient
  sky(kind) {
    const palettes = {
      ring:     { top: 0x12243a, bot: 0x4a6a86 },
      space:    { top: 0x05060f, bot: 0x161a33 },
      interior: { top: 0x0a0e12, bot: 0x1a2630 },
      dusk:     { top: 0x2a1a3a, bot: 0xc06a4a },
    };
    const p = palettes[kind] || palettes.ring;
    const geo = new THREE.SphereGeometry(500, 24, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(p.top) }, bot: { value: new THREE.Color(p.bot) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);}`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bot;
        void main(){ float h = clamp((normalize(vP).y*0.5+0.5),0.0,1.0); gl_FragColor = vec4(mix(bot, top, h),1.0);}`,
    });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, m));
    if (kind === 'space' || kind === 'ring') {
      const N = kind === 'space' ? 900 : 350;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize().multiplyScalar(480);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      }
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(pgeo, new THREE.PointsMaterial({
        color: 0xcfe8ff, size: kind === 'space' ? 1.8 : 1.2, sizeAttenuation: false,
        transparent: true, opacity: kind === 'space' ? 0.95 : 0.55, fog: false, depthWrite: false,
      }));
      g.add(stars);
    }
    if (kind === 'ring' || kind === 'dusk') {
      const sun = new THREE.Mesh(new THREE.CircleGeometry(kind === 'dusk' ? 26 : 16, 24),
        new THREE.MeshBasicMaterial({ color: kind === 'dusk' ? 0xffb060 : 0xfff2cc, fog: false }));
      sun.position.set(-180, kind === 'dusk' ? 50 : 130, -410);
      sun.lookAt(0, 0, 0);
      g.add(sun);
    }
    return g;
  },

  // The signature giant ring on the horizon (original megastructure: "the Aureole")
  aureole() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(220, 10, 8, 80), mat(0x9fb4c6, { metal: 0.2, rough: 0.6, emissive: 0x223344, emissiveIntensity: 0.3 }));
    ring.position.set(0, 60, -260); ring.rotation.x = 1.2;
    const ring2 = ring.clone(); ring2.scale.setScalar(0.5); ring2.position.set(120, 90, -360);
    g.add(ring, ring2);
    return g;
  },

  // Goofy Coalition transport for the finale escape (drivable; see Vehicle.js).
  vehicle() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 3.6), mat(0x6a7a3a, { metal: 0.3, rough: 0.6 }));
    body.position.y = 0.95;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 1.5), mat(0x3a4630, { metal: 0.4 }));
    cabin.position.set(0, 1.55, -0.4);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 1.0), mat(0x55652f));
    nose.position.set(0, 0.85, 2.0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.0, 0.2), mat(0x222222));
    fin.position.set(0, 1.95, -1.5);
    g.add(body, cabin, nose, fin);
    // googly headlamp-eyes on the front (it IS a Coalition vehicle)
    const eL = googlyEye(0.2), eR = googlyEye(0.2);
    eL.position.set(-0.65, 1.0, 2.55); eR.position.set(0.65, 1.0, 2.55);
    g.add(eL, eR);
    // wheels (referenced by Vehicle so it can spin them)
    const wheels = [];
    for (const sx of [-1, 1]) for (const sz of [-1.2, 1.2]) {
      // Pivot at the hub so Vehicle can roll the wheel cleanly via pivot.rotation.x
      // (axle along X); the mesh itself is rotated so its faces point left/right.
      const pivot = new THREE.Group();
      pivot.position.set(sx * 1.25, 0.55, sz);
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.4, 14), mat(0x111111));
      w.rotation.z = Math.PI / 2;
      pivot.add(w);
      g.add(pivot); wheels.push(pivot);
    }
    g.userData.wheels = wheels;
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return g;
  },

  // The lost Vanguard frigate waiting at the end of the escape run — drive into
  // its lit hangar to win. Sleek and human (cyan-lit), against the goofy green
  // Coalition. The hangar mouth faces -Z, toward the incoming track.
  vanguardShip() {
    const g = new THREE.Group();
    const hull = mat(0x707e8c, { metal: 0.75, rough: 0.35 });
    const dark = mat(0x1b2730, { metal: 0.6, rough: 0.5 });
    const lit = (i = 1.4) => mat(0x0a2a36, { emissive: 0x5fd0e6, emissiveIntensity: i });

    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 6.5, 26), hull); body.position.set(0, 5, 2);
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 5.2, 9, 4), hull);
    bow.rotation.x = Math.PI / 2; bow.rotation.z = Math.PI / 4; bow.position.set(0, 5, 19.5);
    const keel = new THREE.Mesh(new THREE.BoxGeometry(7, 2.4, 24), dark); keel.position.set(0, 1.6, 2);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 7), hull); bridge.position.set(0, 9.4, 6);
    const wins = new THREE.Mesh(new THREE.BoxGeometry(6.1, 1.0, 2), lit(1.0)); wins.position.set(0, 9.8, 2.6);
    g.add(body, bow, keel, bridge, wins);

    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(7, 0.8, 10), hull);
      wing.position.set(sx * 8.5, 4.4, 3); wing.rotation.z = sx * 0.12;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(7, 0.25, 0.6), lit(1.6));
      strip.position.set(sx * 8.5, 4.85, 8);
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2, 16), dark);
      eng.rotation.x = Math.PI / 2; eng.position.set(sx * 3.4, 4.6, -12);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1.2, 16), mat(0x9fe8ff, { emissive: 0x9fe8ff, emissiveIntensity: 2 }));
      glow.position.set(sx * 3.4, 4.6, -13.05);
      g.add(wing, strip, eng, glow);
    }

    // HANGAR opening on the -Z face — the drive-in target (low, at road level)
    const frame = new THREE.Mesh(new THREE.BoxGeometry(9, 6.6, 1.2), lit(1.9)); frame.position.set(0, 2.8, -11.0);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(7, 4.8, 4), mat(0x02060a, { emissive: 0x0a2230, emissiveIntensity: 0.6 }));
    mouth.position.set(0, 2.6, -9.4);
    const bayLight = new THREE.PointLight(0x5fd0e6, 6, 40); bayLight.position.set(0, 3.2, -7);
    g.add(frame, mouth, bayLight);

    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return g;
  },

  muzzleFlash(color = 0xfff0a0) {
    // shared geometry (this spawns once per SHOT); the material stays per-instance
    // because the FX fade animates its opacity
    if (!_muzzleGeo) { _muzzleGeo = new THREE.SphereGeometry(0.12, 8, 6); _muzzleGeo.userData.shared = true; }
    return new THREE.Mesh(_muzzleGeo, mat(color, { emissive: color, emissiveIntensity: 2, transparent: true, opacity: 0.9 }));
  },

  // Projectiles spawn every shot — geometry and material are cached per type.
  // Grenades get a cloned material (goobers pulse emissiveIntensity on stick).
  projectileMesh(type) {
    let c = _projCache.get(type);
    if (!c) {
      c =
        type === 'goo' ? { geo: new THREE.SphereGeometry(0.14, 8, 8), mat: mat(0x6cd06c, { emissive: 0x39ff39, emissiveIntensity: 1.2 }) } :
        type === 'shard' ? { geo: new THREE.ConeGeometry(0.06, 0.34, 6), mat: mat(0xff7fd0, { emissive: 0xff3fb0, emissiveIntensity: 1.2 }) } :
        type === 'grenade' ? { geo: new THREE.SphereGeometry(0.16, 10, 10), mat: mat(0x335533, { emissive: 0x66aa66, emissiveIntensity: 0.4 }), cloneMat: true } :
        type === 'bossbolt' ? { geo: new THREE.SphereGeometry(0.3, 10, 10), mat: mat(0xff5a8a, { emissive: 0xff2a6a, emissiveIntensity: 1.2 }) } :
        { geo: new THREE.SphereGeometry(0.1, 6, 6), mat: mat(0xffffff) };
      _projCache.set(type, c);
    }
    return new THREE.Mesh(c.geo, c.cloneMat ? c.mat.clone() : c.mat);
  },
};
