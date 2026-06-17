// Survival.js — an endless Horde mode entered from the main menu. A single
// enclosed arena (built through the normal mission pipeline) where escalating
// waves of the Wobble Coalition pour in. Clear a wave for a short breather and a
// pickup, then the next wave arrives bigger and meaner. You score per kill plus a
// per-wave bonus; your best wave and score persist in localStorage. When you go
// down, a game-over card offers Try Again or Main Menu.
//
// The Game suppresses the level's room win/advance while survival runs
// (LevelBuilder.freeplay) and lets this controller own all spawning, scoring, and
// the end state. Containment/anti-soft-lock from LevelBuilder still applies, so
// wave enemies stay reachable.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';
import { normalizeMission } from '../missions/schema.js';

const SCORE = { blork: 10, floater: 15, wobbler: 25, gurg: 30, popper: 20, blinker: 30, medic: 40, bulwark: 45, sprocket: 200, boss: 500 };
const BEST_KEY = 'webalo.survival.best';
function loadBest() { try { return JSON.parse(localStorage.getItem(BEST_KEY)) || { wave: 0, score: 0 }; } catch (e) { return { wave: 0, score: 0 }; } }
function saveBest(b) { try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ } }

// A bright, enclosed combat arena. No enemies/pickups in the data — survival
// spawns those itself, wave by wave.
export const SURVIVAL_MISSION = normalizeMission({
  id: 'survival', name: 'Survival', brief: '', outro: '',
  skybox: 'ring', music: 'combat',
  palette: { floor: '#5a6470', wall: '#3a424c', accent: '#ff6a3d', fog: '#8a97a4' },
  startWeapons: ['rifle', 'pistol'],
  segments: [
    { kind: 'arena', size: 'l', objectiveText: 'Survive', enemies: [], pickups: [], cover: 0.35, event: 'none', dialogue: [] },
  ],
}, 0);

export class Survival {
  constructor(root, game, onExit) {
    this.root = root;
    this.game = game;
    this.onExit = onExit;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.state = 'intro';      // intro -> fighting -> breather -> (loop) / over
    this.timer = 2.2;          // intro countdown before wave 1
    this._live = [];           // enemies of the current wave
    this.best = loadBest();

    this.hudEl = document.createElement('div');
    this.hudEl.className = 'survival-hud hidden';
    this.hudEl.innerHTML = `<div class="sv-wave"></div><div class="sv-score"></div><div class="sv-foe"></div>`;
    root.appendChild(this.hudEl);
    this.overEl = null;
  }

  start() {
    this.hudEl.classList.remove('hidden');
    this._render();
    this.game.hud && this.game.hud.banner('SURVIVAL', 'Hold the line — the Wobble keep coming.', 2.0);
  }
  destroy() {
    if (this.hudEl && this.hudEl.parentNode) this.hudEl.parentNode.removeChild(this.hudEl);
    this._clearOver();
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (this.state === 'over') return;
    if (p && p.dead) { this._gameOver(); return; }

    // tally kills as wave enemies die (covers force-killed stragglers too)
    for (const e of this._live) {
      if (e.dead && !e._svCounted) { e._svCounted = true; this.kills++; this.score += (SCORE[e.type] || 10); }
    }

    if (this.state === 'intro') {
      this.timer -= dt;
      if (this.timer <= 0) this._startWave(1);
    } else if (this.state === 'fighting') {
      if (this._live.filter((e) => !e.dead).length === 0) {
        this.score += this.wave * 25;                 // wave-clear bonus
        this.state = 'breather'; this.timer = 4.0;
        g.hud && g.hud.banner('WAVE ' + this.wave + ' CLEARED', 'Catch your breath.', 1.6);
        this._spawnPickup(g);
      }
    } else if (this.state === 'breather') {
      this.timer -= dt;
      if (this.timer <= 0) this._startWave(this.wave + 1);
    }
    this._render();
  }

  // ---- waves ----------------------------------------------------------------
  _startWave(n) {
    this.wave = n; this.state = 'fighting';
    const g = this.game, ctx = g._ctx();
    this._live = [];
    for (const [type, count] of this._composition(n)) {
      for (let i = 0; i < count; i++) this._live.push(this._spawnAt(g, ctx, type));
    }
    const boss = n % 5 === 0;
    g.hud && g.hud.banner('WAVE ' + n, boss ? 'A mini-boss joins the fray!' : 'Incoming Wobble.', 1.6);
    g.hud && g.hud.setObjective('SURVIVAL — Wave ' + n);
    g.audio && g.audio.sfx('objective');
  }

  // Escalating mix: more bodies each wave, tougher types phased in, a sprocket
  // mini-boss every 5th wave. Counts are capped to keep the arena (and frame
  // rate) sane.
  _composition(n) {
    const out = [['blork', Math.min(9, 2 + n)]];
    if (n >= 2) out.push(['floater', Math.min(4, Math.floor(n / 2))]);
    if (n >= 3) out.push(['popper', Math.min(3, Math.floor((n - 1) / 2))]);
    if (n >= 3) out.push(['gurg', Math.min(2, Math.floor((n - 1) / 3))]);
    if (n >= 4) out.push(['bulwark', Math.min(2, Math.floor((n - 2) / 3))]);
    if (n >= 5) out.push(['blinker', Math.min(3, Math.floor((n - 3) / 2))]);
    if (n >= 4) out.push(['wobbler', Math.min(2, Math.floor((n - 2) / 4))]);
    if (n >= 6 && n % 2 === 0) out.push(['medic', 1]);   // a healer shows up to be prioritized
    if (n % 5 === 0) out.push(['sprocket', 1]);
    return out;
  }

  _spawnAt(g, ctx, type) {
    const room = g.level.segments[g.level.activeIndex];
    const p = g.player.pos;
    let x = 0, z = 0, tries = 0;
    do {
      x = (Math.random() - 0.5) * (room.w - 4);
      z = room.zFront + 2 + Math.random() * (room.d - 4);
      tries++;
    } while (Math.hypot(x - p.x, z - p.z) < 8 && tries < 14);   // not on top of the player
    const air = type === 'floater' || type === 'wobbler';
    const e = ctx.spawnEnemy(type, new THREE.Vector3(x, air ? 2.2 : 0.1, z));
    if (air) e.hover = true;
    e.hunt = true;                 // horde: always charge the player, never camp out of range
    room.enemies.push(e);
    return e;
  }

  _spawnPickup(g) {
    const room = g.level.segments[g.level.activeIndex];
    const type = this.wave % 2 === 0 ? 'ammo' : 'health';
    const mesh = AssetFactory.pickup(type);
    const x = (Math.random() - 0.5) * (room.w - 8);
    const z = room.zFront + 3 + Math.random() * (room.d - 6);
    mesh.position.set(x, 0.8, z);
    g.scene.add(mesh);
    g.level.pickups.push({ mesh, type, weapon: null, pos: mesh.position.clone(), taken: false, room });
  }

  // ---- end state ------------------------------------------------------------
  _gameOver() {
    if (this.state === 'over') return;
    this.state = 'over';
    const g = this.game;
    if (this.wave > this.best.wave) this.best.wave = this.wave;
    if (this.score > this.best.score) this.best.score = this.score;
    saveBest(this.best);
    g._setPlayInput(false); g.input.exitLock();
    g.state = 'result';                       // stops the play loop (and the campaign fail path)
    g.audio && g.audio.sfx('lose');
    g.hud && g.hud.show(false);
    this.hudEl.classList.add('hidden');
    this._showOver();
  }

  _showOver() {
    const g = this.game;
    this.overEl = document.createElement('div');
    this.overEl.className = 'interactive';
    this.overEl.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title" style="font-size:54px">You Are Down</div>
          <div class="game-tag">You survived <b>${this.wave}</b> wave${this.wave === 1 ? '' : 's'} · Score <b>${this.score}</b></div>
          <div class="game-tag" style="opacity:.72">Best · wave ${this.best.wave} · score ${this.best.score}</div>
        </div>
        <div class="menu-list">
          <button class="btn primary" data-act="retry">↻ Try Again</button>
          <button class="btn" data-act="menu">⏏ Main Menu</button>
        </div>
      </div>`;
    this.root.appendChild(this.overEl);
    this.overEl.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      g.audio && g.audio.sfx('ui');
      const a = b.dataset.act;
      this._clearOver();
      if (a === 'retry') g.startSurvival();
      else g.quitToMenu();
    }));
  }
  _clearOver() { if (this.overEl && this.overEl.parentNode) this.overEl.parentNode.removeChild(this.overEl); this.overEl = null; }

  _render() {
    this.hudEl.querySelector('.sv-wave').textContent = 'WAVE ' + (this.wave || '—');
    this.hudEl.querySelector('.sv-score').textContent = 'SCORE ' + this.score;
    const foe = this.hudEl.querySelector('.sv-foe');
    if (this.state === 'fighting') foe.textContent = this._live.filter((e) => !e.dead).length + ' left';
    else if (this.state === 'breather') foe.textContent = 'next wave…';
    else foe.textContent = '';
  }
}
