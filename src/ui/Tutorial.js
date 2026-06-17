// Tutorial.js — a guided "Training" mode entered from the main menu. It runs on a
// real (but damage-free) arena built through the normal mission pipeline, and walks
// the player through every control and the basics of the HUD, the enemies, and the
// finale. Each step shows a control-aware instruction (mouse+keyboard vs. the touch
// controls) and advances the moment the player actually performs the action — so it
// teaches by doing, not by reading. Info steps advance on the Jump control.
//
// The Game suppresses mission win/advance while a tutorial is active (LevelBuilder
// .tutorial) and sets the player's damage multiplier to 0, so Training is a safe
// sandbox the player can leave any time via Pause.

import * as THREE from 'three';
import { AssetFactory } from '../core/AssetFactory.js';
import { codeLabel } from '../core/Settings.js';
import { GAMEPAD_BUTTONS } from '../core/Input.js';
import { normalizeMission } from '../missions/schema.js';

// A calm, enclosed arena with a console (for the Interact step). No enemies or
// pickups in the data — the tutorial spawns those itself, when their step begins.
export const TUTORIAL_MISSION = normalizeMission({
  id: 'tutorial', name: 'Training',
  brief: '', outro: '',
  // A bright, open arena so targets and pickups read clearly while learning.
  skybox: 'ring', music: 'ambient',
  palette: { floor: '#6a7480', wall: '#454d57', accent: '#5fd0e6', fog: '#aeb8c2' },
  startWeapons: ['pistol', 'rifle'],
  segments: [
    { kind: 'arena', size: 'l', objectiveText: 'Training', enemies: [], pickups: [], cover: 0.15, event: 'reactor', dialogue: [] },
  ],
}, 0);

export class Tutorial {
  constructor(root, game, onFinish) {
    this.game = game;
    this.onFinish = onFinish;
    this.i = 0;
    this._done = false;

    this.el = document.createElement('div');
    this.el.className = 'tutorial-overlay hidden';
    this.el.innerHTML = `
      <div class="tut-card">
        <div class="tut-step"></div>
        <div class="tut-title"></div>
        <div class="tut-body"></div>
        <div class="tut-cont"></div>
      </div>
      <div class="tut-exit"></div>`;
    root.appendChild(this.el);

    this.steps = this._buildSteps();
  }

  start() { this._done = false; this.i = 0; this.el.classList.remove('hidden'); this._enterStep(); }
  destroy() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); }

  // ---- control-label helpers -------------------------------------------------
  _lbl(action) { return codeLabel(this.game.settings.bindings[action]); }
  _padLbl(action) { return GAMEPAD_BUTTONS[action] || action; }
  _mode() { return this.game.isTouch ? 'touch' : (this.game.input && this.game.input._gpActive ? 'pad' : 'desktop'); }
  // 3-way control-aware label: desktop / touch / gamepad (pad falls back to desktop)
  _pick(desktop, touch, pad) { const m = this._mode(); return m === 'touch' ? touch : (m === 'pad' && pad != null ? pad : desktop); }
  _totalNades(p) { return (p.grenades.frag || 0) + (p.grenades.goober || 0); }

  // ---- step lifecycle --------------------------------------------------------
  _enterStep() {
    const g = this.game, p = g.player;
    this._t = 0; this._lookAcc = 0; this._adsAcc = 0; this._lastYaw = null; this._lastPitch = null;
    this._moveBase = p.pos.clone();
    this._enterCurrent = p.current;
    this._enterNades = this._totalNades(p);
    const step = this.steps[this.i];
    if (step.enter) step.enter(g, g._ctx());
    this.el.querySelector('.tut-step').textContent = `STEP ${this.i + 1} / ${this.steps.length}`;
    this.el.querySelector('.tut-title').textContent = step.title(g);
    this.el.querySelector('.tut-body').innerHTML = step.body(g);
    const cont = step.cont ? step.cont(g) : (step.kind === 'info' ? this._contHint(g) : '');
    this.el.querySelector('.tut-cont').textContent = cont;
    this.el.querySelector('.tut-exit').textContent = this._pick(`Press ${this._lbl('pause')} to exit training`, 'Tap ❚❚ to exit training', `Press ${this._padLbl('pause')} to exit training`);
    this.el.classList.toggle('info', step.kind === 'info');
  }

  _contHint(g) { return this._pick(`Press ${this._lbl('jump')} to continue`, 'Tap JUMP to continue', `Press ${this._padLbl('jump')} to continue`); }

  update(dt) {
    if (this._done) return;
    const g = this.game, p = g.player, input = g.input;
    if (!p) return;
    this._t += dt;
    if (this._lastYaw != null) this._lookAcc += Math.abs(p.yaw - this._lastYaw) + Math.abs(p.pitch - this._lastPitch);
    this._lastYaw = p.yaw; this._lastPitch = p.pitch;
    if (input.isDown('ads')) this._adsAcc += dt;
    const step = this.steps[this.i];
    if (step.check(g, dt)) this._advance();
  }

  _advance() {
    this.i++;
    if (this.i >= this.steps.length) { this._finish(); return; }
    this.game.audio && this.game.audio.sfx('objective');
    this._enterStep();
  }

  _finish() { this._done = true; this.el.classList.add('hidden'); this.onFinish && this.onFinish(); }

  // ---- world props the steps spawn ------------------------------------------
  _spawnTargets(g, ctx, n) {
    this._targets = [];
    const p = g.player;
    const fwd = p.lookDir(); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1); fwd.normalize();
    const perp = new THREE.Vector3(-fwd.z, 0, fwd.x);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 3.4;
      const pos = p.pos.clone().addScaledVector(fwd, 10).addScaledVector(perp, off);
      pos.y = p.pos.y;
      const e = ctx.spawnEnemy('blork', pos);
      try { e.dmg = 0; } catch (_) { /* meta-driven; harmless if absent */ }
      this._targets.push(e);
    }
  }

  _spawnHealth(g) {
    const p = g.player;
    const fwd = p.lookDir(); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1); fwd.normalize();
    const pos = p.pos.clone().addScaledVector(fwd, 5);
    const mesh = AssetFactory.pickup('health');
    mesh.position.set(pos.x, 0.8, pos.z);
    g.scene.add(mesh);
    const room = g.level.segments[g.level.activeIndex];
    const pk = { mesh, type: 'health', weapon: null, pos: mesh.position.clone(), taken: false, room };
    g.level.pickups.push(pk);
    this._pickup = pk;
  }

  // ---- the script ------------------------------------------------------------
  _buildSteps() {
    const T = this;
    const pick = (d, t, p) => T._pick(d, t, p);
    return [
      {
        kind: 'info', title: () => 'Welcome, Sergeant',
        body: (g) => `You're Sgt. Vance Orion — the last marine standing against the Wobble Coalition. This quick drill covers every control. ${pick('You\'ll use the <b>mouse + keyboard</b>.', 'You\'ll use the <b>on-screen stick and buttons</b>.', 'You\'ll use your <b>controller</b>.')}`,
        check: (g) => g.input.pressed('jump'),
      },
      {
        kind: 'task', title: () => 'Look around',
        body: () => pick('Move the <b>mouse</b> to look around.', 'Drag anywhere on the <b>right half</b> of the screen to look around.', 'Use the <b>right stick</b> to look around.'),
        check: () => T._lookAcc > 1.0,
      },
      {
        kind: 'task', title: () => 'Move',
        body: () => pick(`Walk with <b>${T._lbl('forward')} ${T._lbl('left')} ${T._lbl('back')} ${T._lbl('right')}</b>.`, 'Use the <b>left stick</b> to walk.', 'Use the <b>left stick</b> to walk.'),
        check: (g) => g.player.pos.distanceTo(T._moveBase) > 3,
      },
      {
        kind: 'task', title: () => 'Sprint',
        body: () => pick(`Hold <b>${T._lbl('sprint')}</b> while moving forward to sprint.`, 'Push the <b>left stick</b> all the way forward to sprint.', 'Click the <b>left stick (L3)</b>, or push it fully forward, to sprint.'),
        check: (g) => g.input.isDown('sprint') && g.input.isDown('forward'),
      },
      {
        kind: 'task', title: () => 'Jump',
        body: () => pick(`Press <b>${T._lbl('jump')}</b> to jump.`, 'Tap the <b>JUMP</b> button.', `Press <b>${T._padLbl('jump')}</b> to jump.`),
        check: (g) => g.input.pressed('jump'),
      },
      {
        kind: 'task', title: () => 'Open fire',
        body: () => pick('Aim with the mouse and <b>left-click</b> to shoot. Destroy the three targets.', 'Drag to aim, then <b>tap</b> the right side or hold <b>FIRE</b>. Destroy the three targets — aim-assist helps you connect.', 'Aim with the <b>right stick</b> and pull <b>RT</b> to shoot. Destroy the three targets — aim-assist helps you connect.'),
        enter: (g, ctx) => T._spawnTargets(g, ctx, 3),
        check: () => T._targets && T._targets.length > 0 && T._targets.every((e) => e.dead),
      },
      {
        kind: 'task', title: () => 'Aim down sights',
        body: () => pick('Hold <b>right-click</b> to aim down the sights — steadier and more accurate. Some weapons fire an <b>alternate mode</b> while you aim.', 'Hold the <b>ADS</b> button to aim down the sights. Some weapons fire an <b>alternate mode</b> while you aim.', 'Hold <b>LT</b> to aim down the sights — steadier and more accurate. Some weapons fire an <b>alternate mode</b> while you aim.'),
        check: () => T._adsAcc > 0.5,
      },
      {
        kind: 'task', title: () => 'Reload',
        body: (g) => pick(`Press <b>${T._lbl('reload')}</b> to reload your magazine.`, 'Tap <b>RELOAD</b>, or <b>double-tap</b> the right side. (Empty mags also reload on their own.)', `Press <b>${T._padLbl('reload')}</b> to reload your magazine.`),
        check: (g) => g.input.pressed('reload') || (g.player.weapon && g.player.weapon.reloading > 0),
      },
      {
        kind: 'task', title: () => 'Swap weapons',
        body: () => pick(`You carry two weapons. Press <b>${T._lbl('swap')}</b> to switch between them.`, 'You carry two weapons. Tap <b>SWAP</b> to switch between them.', `You carry two weapons. Press <b>${T._padLbl('swap')}</b> to switch between them.`),
        check: (g) => g.player.current !== T._enterCurrent,
      },
      {
        kind: 'task', title: () => 'Throw a grenade',
        body: () => pick(`Press <b>${T._lbl('grenade')}</b> to cook and lob a grenade.`, 'Tap <b>NADE</b> — or press a <b>second finger</b> on the right side — to lob a grenade.', `Press <b>${T._padLbl('grenade')}</b> to cook and lob a grenade.`),
        check: (g) => T._totalNades(g.player) < T._enterNades,
      },
      {
        kind: 'task', title: () => 'Melee',
        body: () => pick(`Press <b>${T._lbl('melee')}</b> for a close-range melee strike.`, 'Tap <b>MELEE</b> for a close-range strike.', `Press <b>${T._padLbl('melee')}</b> for a close-range strike.`),
        check: (g) => g.input.pressed('melee'),
      },
      {
        kind: 'task', title: () => 'Pickups',
        body: () => 'Spinning diamonds are pickups: <span style="color:#ff6a6a">red = health</span>, <span style="color:#ffd35a">gold = ammo</span>, <span style="color:#7fe0ff">cyan = a weapon</span>. Walk into the red one ahead.',
        enter: (g) => { g.player.health = Math.min(g.player.health, 55); T._spawnHealth(g); },
        check: () => T._pickup && T._pickup.taken,
      },
      {
        kind: 'task', title: () => 'Interact',
        body: () => pick(`Walk up to the glowing console and press <b>${T._lbl('interact')}</b> to use objects like consoles and doors.`, 'Walk up to the glowing console and tap <b>USE</b> to use objects like consoles and doors.', `Walk up to the glowing console and press <b>${T._padLbl('interact')}</b> to use objects like consoles and doors.`),
        check: (g) => { const c = g.level.consoles && g.level.consoles[0]; return !!(c && c.done); },
      },
      {
        kind: 'info', title: () => 'Reading the HUD',
        body: () => 'Your <b>shields</b> (which recharge when you avoid fire) sit over your <b>health</b>. Your <b>ammo</b> and <b>grenades</b> read out near the edge, your current <b>objective</b> shows up top, and a <b>tracker</b> marks nearby Wobble.',
        check: (g) => g.input.pressed('jump'),
      },
      {
        kind: 'info', title: () => 'The Wobble Coalition',
        body: () => 'Your foes: <b>Blorklings</b> swarm in melee, <b>Gurglethuds</b> build up a charge, <b>Bobbins</b> and <b>Sprocket Acolytes</b> hit from range, and named mini-bosses like <b>Quivermaster Sprocket</b> take real firepower to bring down.',
        check: (g) => g.input.pressed('jump'),
      },
      {
        kind: 'info', title: () => 'The escape',
        body: () => pick('In the final mission you drive a ground vehicle along a collapsing ring: steer with your movement keys, hold sprint to boost, and aim + fire the turret at the Wobble. Don\'t drive off the edge — reach your ship before the timer hits zero.', 'In the final mission you drive a ground vehicle along a collapsing ring: steer with the left stick, push it fully forward to boost, and drag + FIRE the turret at the Wobble. Don\'t drive off the edge — reach your ship before the timer hits zero.', 'In the final mission you drive a ground vehicle along a collapsing ring: steer with the <b>left stick</b>, push it fully forward to boost, and aim + pull <b>RT</b> to fire the turret at the Wobble. Don\'t drive off the edge — reach your ship before the timer hits zero.'),
        check: (g) => g.input.pressed('jump'),
      },
      {
        kind: 'info', title: () => 'Training complete',
        body: () => 'That\'s every control. You\'re ready, Sergeant — start <b>New Campaign</b> from the menu when you are. Good hunting.',
        cont: (g) => pick(`Press ${T._lbl('jump')} to return to the menu`, 'Tap JUMP to return to the menu', `Press ${T._padLbl('jump')} to return to the menu`),
        check: (g) => g.input.pressed('jump'),
      },
    ];
  }
}
