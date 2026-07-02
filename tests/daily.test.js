// Daily challenge: everyone must get the SAME challenge for the same date, and
// share codes must round-trip. These invariants are what make the mode work.
import { describe, it, expect } from 'vitest';
import { dayKey, dailyChallenge, makeShareCode, parseShareCode } from '../src/core/Daily.js';
import { MUTATORS, MISSION_MUTATOR_IDS } from '../src/core/Mutators.js';
import { CAMPAIGN } from '../src/missions/campaign.js';

describe('dayKey', () => {
  it('uses the UTC calendar day, not local time', () => {
    // 23:30 UTC on Jan 1 must be Jan 1 everywhere, whatever the box's TZ
    expect(dayKey(new Date(Date.UTC(2026, 0, 1, 23, 30)))).toBe(20260101);
    expect(dayKey(new Date(Date.UTC(2026, 11, 31, 0, 0)))).toBe(20261231);
  });
});

describe('dailyChallenge', () => {
  it('is deterministic: same date, same challenge', () => {
    const d = new Date(Date.UTC(2026, 5, 18, 12));
    const a = dailyChallenge(d), b = dailyChallenge(d);
    expect(a).toEqual(b);
  });
  it('differs across days (seeds and picks rotate)', () => {
    const a = dailyChallenge(new Date(Date.UTC(2026, 5, 18)));
    const b = dailyChallenge(new Date(Date.UTC(2026, 5, 19)));
    expect(a.key).not.toBe(b.key);
    expect(a.survival.seed).not.toBe(b.survival.seed);
  });
  it('always yields valid mutators and a valid mission index', () => {
    for (let i = 0; i < 60; i++) {
      const ch = dailyChallenge(new Date(Date.UTC(2026, 0, 1 + i)));
      for (const id of ch.survival.mutators) expect(MUTATORS[id], id).toBeTruthy();
      for (const id of ch.mission.mutators) expect(MISSION_MUTATOR_IDS).toContain(id);
      expect(ch.mission.index).toBeGreaterThanOrEqual(0);
      expect(ch.mission.index).toBeLessThan(CAMPAIGN.length);
      expect(ch.survival.mutators.length).toBeGreaterThanOrEqual(1);
      expect(ch.survival.mutators.length).toBeLessThanOrEqual(2);
      // no duplicate mutators in a set
      expect(new Set(ch.survival.mutators).size).toBe(ch.survival.mutators.length);
    }
  });
});

describe('share codes', () => {
  it('round-trip key, mode and score', () => {
    const code = makeShareCode(20260618, 'survival', 12345);
    const r = parseShareCode(code);
    expect(r).toEqual({ key: 20260618, mode: 'survival', score: 12345 });
    const m = parseShareCode(makeShareCode(20260618, 'mission', 999));
    expect(m.mode).toBe('mission');
    expect(m.score).toBe(999);
  });
  it('survive lowercase / whitespace paste', () => {
    const code = makeShareCode(20260618, 'survival', 777);
    expect(parseShareCode('  ' + code.toLowerCase() + ' ')).toEqual({ key: 20260618, mode: 'survival', score: 777 });
  });
  it('reject garbage', () => {
    expect(parseShareCode('')).toBeNull();
    expect(parseShareCode('WBL-AB3KD')).toBeNull();       // a co-op room code, not a daily code
    expect(parseShareCode('hello world')).toBeNull();
    expect(parseShareCode(null)).toBeNull();
  });
  it('clamp negative scores to zero', () => {
    expect(parseShareCode(makeShareCode(20260618, 'survival', -50)).score).toBe(0);
  });
});
