// Mission data contracts: every campaign mission must normalize cleanly, and
// every referenced enemy/weapon/pickup type must actually exist.
import { describe, it, expect } from 'vitest';
import { normalizeMission, ENEMY_META } from '../src/missions/schema.js';
import { CAMPAIGN } from '../src/missions/campaign.js';
import { WEAPONS } from '../src/entities/Weapon.js';
import { PERKS, PERK_IDS, applyPerk } from '../src/core/Perks.js';
import { DIFFICULTIES, DIFFICULTY_ORDER, getDifficulty } from '../src/core/Difficulty.js';

describe('campaign data', () => {
  it('has 8 missions, each with segments and a palette', () => {
    expect(CAMPAIGN.length).toBe(8);
    for (const m of CAMPAIGN) {
      expect(m.segments.length).toBeGreaterThan(0);
      expect(m.palette.floor).toMatch(/^#/);
      expect(m.name).toBeTruthy();
    }
  });
  it('references only real enemy types and weapons', () => {
    for (const m of CAMPAIGN) {
      for (const w of m.startWeapons) expect(WEAPONS[w], `${m.id} weapon ${w}`).toBeTruthy();
      for (const seg of m.segments) {
        for (const g of seg.enemies) expect(ENEMY_META[g.type], `${m.id} enemy ${g.type}`).toBeTruthy();
        for (const p of seg.pickups) {
          expect(['ammo', 'health', 'weapon']).toContain(p.type);
          if (p.type === 'weapon') expect(WEAPONS[p.weapon], `${m.id} pickup ${p.weapon}`).toBeTruthy();
        }
      }
    }
  });
  it('exactly one finale, and it ends in a vehicle escape', () => {
    const finales = CAMPAIGN.filter((m) => m.finale);
    expect(finales.length).toBe(1);
    const last = finales[0].segments[finales[0].segments.length - 1];
    expect(last.event).toBe('vehicle-escape');
  });
  it('normalizeMission fills defaults on a sparse mission', () => {
    const m = normalizeMission({ id: 'x', name: 'X', segments: [{}] }, 0);
    expect(m.segments[0].enemies).toEqual([]);
    expect(m.segments[0].pickups).toEqual([]);
    expect(m.palette).toBeTruthy();
  });
});

describe('perks & difficulty', () => {
  it('every perk applies cleanly to a player-shaped object', () => {
    for (const id of PERK_IDS) {
      const p = { shieldMax: 70, healthMax: 45, shieldRegen: 38, shieldRegenDelay: 3, healMult: 1, moveMult: 1, shieldDmgMult: 1, healOnKill: 0, reloadMult: 1, grenadeBonus: 0 };
      applyPerk(p, id);
      expect(PERKS[id].name).toBeTruthy();
      for (const k of Object.keys(p)) expect(Number.isFinite(p[k]), `${id}.${k}`).toBe(true);
    }
  });
  it('difficulty tiers are ordered easier→harder and lookup falls back safely', () => {
    for (let i = 1; i < DIFFICULTY_ORDER.length; i++) {
      const prev = DIFFICULTIES[DIFFICULTY_ORDER[i - 1]], cur = DIFFICULTIES[DIFFICULTY_ORDER[i]];
      expect(cur.dmgTaken).toBeGreaterThan(prev.dmgTaken);
      expect(cur.enemyHealth).toBeGreaterThanOrEqual(prev.enemyHealth);
    }
    expect(getDifficulty('nope')).toBe(DIFFICULTIES.trooper);
  });
});
