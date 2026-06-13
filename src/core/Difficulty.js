// Difficulty.js — selectable difficulty tiers. Each tier scales how much damage
// the player takes and how much health enemies have. Threaded through
// Player.takeDamage (dmgTaken) and Game enemy spawning (enemyHealth). Names are
// original/parody-flavored, not borrowed from any other game.

export const DIFFICULTIES = {
  recruit: { key: 'recruit', name: 'Recruit', blurb: 'A gentle stroll. The Coalition hits soft and folds fast.', dmgTaken: 0.55, enemyHealth: 0.8 },
  trooper: { key: 'trooper', name: 'Trooper', blurb: 'The intended Webalo experience. Balanced and squeaky.', dmgTaken: 1.0, enemyHealth: 1.0 },
  veteran: { key: 'veteran', name: 'Veteran', blurb: 'The Wobble Coalition stops being funny. Tougher, meaner.', dmgTaken: 1.6, enemyHealth: 1.3 },
  legend:  { key: 'legend',  name: 'Legend',  blurb: 'They hit like trucks and soak like sponges. Good luck, Sergeant.', dmgTaken: 2.4, enemyHealth: 1.6 },
};

export const DIFFICULTY_ORDER = ['recruit', 'trooper', 'veteran', 'legend'];

export function getDifficulty(key) { return DIFFICULTIES[key] || DIFFICULTIES.trooper; }
