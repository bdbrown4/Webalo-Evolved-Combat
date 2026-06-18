// Mutators.js — optional run modifiers that remix a Survival or campaign run.
// Each mutator declares simple multipliers (and nothing else), so they compose
// cleanly: combineMods() folds an active set into one effect object the Game
// applies at the handful of spawn / mission-start hooks that read it. Keeping the
// surface this small is deliberate — a mutator can never reach into combat code,
// so any combination is safe to stack (the Daily Challenge picks them blind).
//
//   enemyHealth / enemySpeed / enemyCount  — scale the Wobble
//   playerDmgTaken / playerHealthMax       — scale the marine
//   gravity                                — scale world gravity (jumps + ragdolls)

export const MUTATORS = {
  glasscannon: { name: 'Glass Cannon', icon: '💥', desc: 'Everything dies fast — including you. Enemies at 55% HP, you take ×2.2 damage.', enemyHealth: 0.55, playerDmgTaken: 2.2 },
  horde:       { name: 'Horde Night',  icon: '👾', desc: '60% more Wobble pour in.', enemyCount: 1.6, survivalOnly: true },
  juggernaut:  { name: 'Juggernauts',  icon: '🛡️', desc: 'Tanky and slow — enemies at 190% HP, 72% speed.', enemyHealth: 1.9, enemySpeed: 0.72 },
  sugarrush:   { name: 'Sugar Rush',   icon: '⚡', desc: 'The Coalition is wired — ×1.5 enemy speed.', enemySpeed: 1.5 },
  moonboots:   { name: 'Moon Boots',   icon: '🌙', desc: 'Low gravity. Floaty jumps, floatier death tumbles.', gravity: 0.4 },
  fragile:     { name: 'Fragile',      icon: '💔', desc: 'Half your max health. Make every shield count.', playerHealthMax: 0.5 },
  swarm:       { name: 'Swarm',        icon: '🐝', desc: 'Twice the bodies, half the HP each.', enemyCount: 1.8, enemyHealth: 0.55, survivalOnly: true },
  thickskull:  { name: 'Thick Skulls', icon: '🪨', desc: 'The Wobble soak it up — enemies at 150% HP.', enemyHealth: 1.5 },
};
export const MUTATOR_IDS = Object.keys(MUTATORS);
// Missions have authored spawns, so enemy-count mutators do nothing there — the
// Mission of the Day draws only from mutators that work against a fixed roster.
export const MISSION_MUTATOR_IDS = MUTATOR_IDS.filter((id) => !MUTATORS[id].survivalOnly);

// Neutral effect — what an un-mutated run uses (and the base we multiply onto).
export function noMods() {
  return { enemyHealth: 1, enemySpeed: 1, enemyCount: 1, playerDmgTaken: 1, playerHealthMax: 1, gravity: 1 };
}

// Fold a list of mutator ids into one combined effect object.
export function combineMods(ids) {
  const m = noMods();
  for (const id of ids || []) {
    const d = MUTATORS[id];
    if (!d) continue;
    for (const k of Object.keys(m)) if (d[k] != null) m[k] *= d[k];
  }
  return m;
}

export function mutatorName(id) { return MUTATORS[id] ? MUTATORS[id].name : id; }
