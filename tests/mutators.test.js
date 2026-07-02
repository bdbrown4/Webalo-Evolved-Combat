// Mutators must compose safely in any combination — the daily picks them blind.
import { describe, it, expect } from 'vitest';
import { MUTATORS, MUTATOR_IDS, MISSION_MUTATOR_IDS, combineMods, noMods } from '../src/core/Mutators.js';

const EFFECT_KEYS = Object.keys(noMods());

describe('combineMods', () => {
  it('empty/unknown input is the neutral effect', () => {
    expect(combineMods([])).toEqual(noMods());
    expect(combineMods(undefined)).toEqual(noMods());
    expect(combineMods(['not-a-mutator'])).toEqual(noMods());
  });
  it('multiplies stacked effects', () => {
    const m = combineMods(['thickskull', 'juggernaut']); // 1.5 * 1.9 enemy HP
    expect(m.enemyHealth).toBeCloseTo(1.5 * 1.9);
    expect(m.enemySpeed).toBeCloseTo(0.72);
  });
  it('every declared field is a known effect key (no silent typos)', () => {
    for (const id of MUTATOR_IDS) {
      for (const k of Object.keys(MUTATORS[id])) {
        if (['name', 'icon', 'desc', 'survivalOnly'].includes(k)) continue;
        expect(EFFECT_KEYS, `${id}.${k}`).toContain(k);
      }
    }
  });
  it('all pairs produce positive, finite effects', () => {
    for (const a of MUTATOR_IDS) for (const b of MUTATOR_IDS) {
      const m = combineMods([a, b]);
      for (const k of EFFECT_KEYS) {
        expect(Number.isFinite(m[k]), `${a}+${b}.${k}`).toBe(true);
        expect(m[k], `${a}+${b}.${k}`).toBeGreaterThan(0);
      }
    }
  });
  it('mission pool excludes enemy-count mutators (missions have authored spawns)', () => {
    for (const id of MISSION_MUTATOR_IDS) expect(MUTATORS[id].enemyCount).toBeUndefined();
    expect(MISSION_MUTATOR_IDS.length).toBeGreaterThan(0);
  });
});
