// Perks.js — the between-mission upgrade pool (roguelite-lite). After each
// campaign mission you pick 1 of 3 drawn from here; chosen perk ids persist with
// progress and are re-applied to the fresh Player at the start of every mission.
//
// Each `apply` only sets instance-level MAXES / MULTIPLIERS on the Player (no
// current-vital writes) so it's idempotent and plays nicely with checkpoint
// resume — the Game refills vitals and mirrors weapon stats after applying.
// None lean on "headshots": the Wobble are googly-eyed blobs, not heads.

export const PERKS = {
  plating:   { name: 'Reinforced Plating', desc: '+30% maximum shields',
               apply: (p) => { p.shieldMax = Math.round(p.shieldMax * 1.3); } },
  recharge:  { name: 'Rapid Recharge', desc: 'Shields recover faster and sooner',
               apply: (p) => { p.shieldRegen *= 1.5; p.shieldRegenDelay *= 0.5; } },
  rations:   { name: 'Field Rations', desc: '+18 max health · pickups heal more',
               apply: (p) => { p.healthMax += 18; p.healMult *= 1.3; } },
  quick:     { name: 'Quick Hands', desc: '25% faster reloads',
               apply: (p) => { p.reloadMult *= 0.75; } },
  bandolier: { name: 'Bandolier', desc: '+1 frag and +1 goober grenade',
               apply: (p) => { p.grenadeBonus += 1; } },
  lightstep: { name: 'Light Step', desc: '+12% move and sprint speed',
               apply: (p) => { p.moveMult *= 1.12; } },
  gooeater:  { name: 'Goo-Eater', desc: '+30% damage to enemy shields',
               apply: (p) => { p.shieldDmgMult *= 1.3; } },
  siphon:    { name: 'Goo Siphon', desc: 'Heal 6 HP on each kill',
               apply: (p) => { p.healOnKill += 6; } },
};

export const PERK_IDS = Object.keys(PERKS);

export function applyPerk(player, id) {
  const perk = PERKS[id];
  if (perk) perk.apply(player);
}
