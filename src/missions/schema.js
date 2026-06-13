// schema.js — the mission DATA contract + shared lore metadata used for HUD
// display names. A mission is plain data; LevelBuilder turns it into geometry,
// colliders, enemy spawns, pickups, objectives, and scripted events. To add a
// mission, drop a new object matching this shape into campaign.js — no engine
// code required.
//
// Mission = {
//   id, name, brief, outro,
//   skybox:  "ring" | "space" | "interior" | "dusk",
//   music:   "ambient" | "tension" | "combat" | "finale",
//   palette: { floor, wall, accent, fog }   // hex strings
//   startWeapons: [weaponKey...]            // 1-2 of WEAPON keys
//   finale: boolean,
//   segments: [ Segment... ]                // played in order, gated by clear
// }
//
// Segment = {
//   kind: "arena"|"corridor"|"hall"|"outdoor"|"bridge",
//   size: "s"|"m"|"l",
//   objectiveText: string,                  // shown while this segment is active
//   enemies: [{ type, count }],             // type in ENEMY keys
//   pickups: [{ type:"health"|"ammo"|"weapon", weapon? }],
//   cover: 0..1,                            // cover-prop density
//   event: "none"|"ambush"|"door-lock"|"reactor"|"vehicle-escape"|"boss",
//   dialogue: [{ speaker, line }],          // played on entering the segment
// }

export const ENEMY_META = {
  blork:   { name: 'Blorkling',  hp: 14,  speed: 5.2, dmg: 6,  range: 2.0,  kind: 'melee',  scoreColor: 0xff8a3d },
  gurg:    { name: 'Gurglethud', hp: 90,  speed: 3.0, dmg: 28, range: 2.6,  kind: 'charger',scoreColor: 0x7d57c9 },
  wobbler: { name: 'Quivermaster Sprocket', hp: 70, speed: 3.4, dmg: 12, range: 22, kind: 'ranged', shield: 60, scoreColor: 0x35c98f },
  floater: { name: 'Bobbins',    hp: 26,  speed: 3.0, dmg: 10, range: 26,  kind: 'ranged', hover: true, scoreColor: 0xe8d24a },
  boss:    { name: 'Supreme Jiggler Pomplemoose', hp: 1400, speed: 1.6, dmg: 26, range: 30, kind: 'boss', shield: 0, scoreColor: 0xd83a6a },
};

export const WEAPON_META = {
  pistol:    { name: "M7 'Caretaker'" },
  rifle:     { name: 'AR-22 Bulwark' },
  goocaster: { name: "Type-G Goocaster" },
  stinger:   { name: 'VX-9 Stinger' },
  boomstick: { name: 'D-12 Boomstick' },
};

export const SKYBOXES = ['ring', 'space', 'interior', 'dusk'];
export const SEGMENT_KINDS = ['arena', 'corridor', 'hall', 'outdoor', 'bridge'];

// Defensive normalization so a slightly-off data file never crashes the engine.
export function normalizeMission(m, index) {
  const safe = m && typeof m === 'object' ? m : {};
  return {
    id: safe.id || `m${String(index + 1).padStart(2, '0')}`,
    name: safe.name || `Mission ${index + 1}`,
    brief: safe.brief || '',
    outro: safe.outro || '',
    skybox: SKYBOXES.includes(safe.skybox) ? safe.skybox : 'ring',
    music: ['ambient', 'tension', 'combat', 'finale'].includes(safe.music) ? safe.music : 'tension',
    palette: {
      floor: safe.palette?.floor || '#3a4450',
      wall: safe.palette?.wall || '#2b333d',
      accent: safe.palette?.accent || '#5fd0e6',
      fog: safe.palette?.fog || '#141a20',
    },
    startWeapons: (Array.isArray(safe.startWeapons) && safe.startWeapons.length ? safe.startWeapons : ['pistol']).slice(0, 2),
    finale: !!safe.finale,
    segments: (Array.isArray(safe.segments) ? safe.segments : []).map((s) => ({
      kind: SEGMENT_KINDS.includes(s.kind) ? s.kind : 'arena',
      size: ['s', 'm', 'l'].includes(s.size) ? s.size : 'm',
      objectiveText: s.objectiveText || 'Eliminate the Wobble Coalition',
      enemies: (Array.isArray(s.enemies) ? s.enemies : []).filter((e) => ENEMY_META[e.type]).map((e) => ({ type: e.type, count: Math.max(0, Math.min(12, e.count | 0)) })),
      pickups: Array.isArray(s.pickups) ? s.pickups : [],
      cover: typeof s.cover === 'number' ? Math.max(0, Math.min(1, s.cover)) : 0.4,
      event: ['none', 'ambush', 'door-lock', 'reactor', 'vehicle-escape', 'boss'].includes(s.event) ? s.event : 'none',
      dialogue: Array.isArray(s.dialogue) ? s.dialogue : [],
    })),
  };
}
