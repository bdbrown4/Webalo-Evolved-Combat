// Daily.js — a once-a-day, everyone-gets-the-same Challenge, derived entirely
// from the calendar date (no server, no accounts). The date seeds a deterministic
// RNG that picks the arena layout (via Game's level seed), a rotating mutator set,
// and — for the Mission of the Day — which campaign mission runs. Your best score
// for each day persists in localStorage, and a short share code lets a friend
// paste in your result to chase the same seed.

import { MUTATOR_IDS, MISSION_MUTATOR_IDS } from './Mutators.js';
import { CAMPAIGN } from '../missions/campaign.js';

// UTC calendar day as YYYYMMDD (a stable integer key + the daily seed). UTC — not
// local time — so the "everyone gets the same Challenge" promise holds across
// time zones: two players a continent apart compute the same key for the same day.
export function dayKey(date = new Date()) {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}
export function dayLabel(date = new Date()) {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Small deterministic LCG seeded from an integer — same date, same sequence.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
function pickSome(rnd, arr, n) {
  const pool = arr.slice(), out = [];
  for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

// The two daily challenges for a given date. 'survival' is a seeded horde run with
// one or two mutators; 'mission' is a rotating campaign mission with one mutator.
export function dailyChallenge(date = new Date()) {
  const key = dayKey(date);
  const rs = rng(key ^ 0x53);             // survival stream
  const rm = rng(key ^ 0x4d);             // mission stream
  const survMutCount = rs() < 0.4 ? 2 : 1;
  return {
    key,
    label: dayLabel(date),
    survival: { seed: key ^ 0x51, mutators: pickSome(rs, MUTATOR_IDS, survMutCount) },
    mission: {
      seed: key ^ 0x4d1,
      index: Math.floor(rm() * CAMPAIGN.length),
      mutators: pickSome(rm, MISSION_MUTATOR_IDS, 1),
    },
  };
}

// ---- best-score persistence (per day, per mode) ----------------------------
const bestKey = (key, mode) => `webalo.daily.${key}.${mode}`;
export function loadDailyBest(key, mode) {
  try { return JSON.parse(localStorage.getItem(bestKey(key, mode))) || null; } catch (e) { return null; }
}
export function saveDailyBest(key, mode, result) {
  const prev = loadDailyBest(key, mode);
  if (prev && prev.score >= result.score) return prev;          // keep the better run
  try { localStorage.setItem(bestKey(key, mode), JSON.stringify(result)); } catch (e) { /* ignore */ }
  return result;
}

// ---- share codes -----------------------------------------------------------
// WBL-D-<day b36>-<S|M>-<score b36>. Human-pasteable, no server round-trip.
export function makeShareCode(key, mode, score) {
  return `WBL-D-${key.toString(36).toUpperCase()}-${mode === 'mission' ? 'M' : 'S'}-${Math.max(0, Math.round(score)).toString(36).toUpperCase()}`;
}
export function parseShareCode(code) {
  const m = /^WBL-D-([0-9A-Z]+)-([SM])-([0-9A-Z]+)$/i.exec((code || '').trim());
  if (!m) return null;
  return { key: parseInt(m[1], 36), mode: m[2].toUpperCase() === 'M' ? 'mission' : 'survival', score: parseInt(m[3], 36) };
}
