// Game.js — the engine core: renderer + scene, the menu/loading/playing/paused
// state machine, per-mission setup, the fixed-step-ish update loop, combat FX
// (tracers, impacts, explosions, muzzle flash, screen shake), and the result
// flow. Holds the authoritative lists of enemies and projectiles and exposes the
// spawn/callback `ctx` that Player, Enemy, and LevelBuilder act through.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Physics } from '../engine/Physics.js';
import { Player } from '../entities/Player.js';
import { Enemy } from '../entities/Enemy.js';
import { Projectile } from '../entities/Projectile.js';
import { Vehicle } from '../entities/Vehicle.js';
import { LevelBuilder } from '../world/LevelBuilder.js';
import { AssetFactory } from './AssetFactory.js';
import { getDifficulty, DIFFICULTY_ORDER } from './Difficulty.js';
import { codeLabel } from './Settings.js';
import { PERKS, PERK_IDS, applyPerk } from './Perks.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { Tutorial, TUTORIAL_MISSION } from '../ui/Tutorial.js';
import { Survival, SURVIVAL_MISSION } from '../ui/Survival.js';
import { CAMPAIGN, markCompleted, loadCheckpoint, saveCheckpoint, clearCheckpoint, loadProgress, saveProgress } from '../missions/campaign.js';

// Touch-device detection. `?touch=1`/`?touch=0` force it on/off (handy for hybrid
// laptops and for testing the touch UI in a desktop browser).
function detectTouch() {
  try {
    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1' || q === 'true') return true;
    if (q === '0' || q === 'false') return false;
  } catch (e) { /* no location */ }
  const mm = window.matchMedia;
  const coarse = !!(mm && mm('(pointer: coarse)').matches);   // primary pointer is touch
  const noHover = !!(mm && mm('(hover: none)').matches);
  const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  // Touch-primary devices (phones/tablets) report a coarse primary pointer; a
  // touchscreen laptop keeps a fine primary pointer + hover, so it stays on
  // mouse/keyboard. Override either way with ?touch=1 / ?touch=0.
  return coarse || (noHover && hasTouch);
}

export class Game {
  constructor(canvas, root, settings, input, audio) {
    this.canvas = canvas;
    this.root = root;
    this.settings = settings;
    this.input = input;
    this.audio = audio;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // filmic response curve instead of raw clamped output — kills the flat,
    // cartoon-flat look on bright emissives (OutputPass picks this up too)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera = new THREE.PerspectiveCamera(settings.data.video.fov, innerWidth / innerHeight, 0.05, 1000);
    this.scene = new THREE.Scene();
    this.scene.add(this.camera);

    // Post-processing: bloom, wired to the 'video.bloom' setting. When bloom is
    // off we render straight to the canvas and skip the composer entirely.
    // The multisampled target keeps MSAA parity with the direct render path.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(
      innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.4, 0.85);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.physics = new Physics();
    this.enemies = [];
    this.projectiles = [];
    this.fx = [];
    this.state = 'menu';
    this.shakeAmt = 0;
    this.missionIndex = 0;
    this.vehicle = null;
    this._diff = getDifficulty('trooper');
    this._resume = false;

    this.hud = new HUD(root, settings);
    this.hud.show(false);

    this._viewModel = null;
    this._vmKey = null;
    this._scoped = false;
    // one persistent muzzle light (adding/removing lights per shot would force
    // shader recompiles); intensity spikes on fire and decays in _updatePlay
    this._muzzleLight = new THREE.PointLight(0xffd9a0, 0, 8, 2);
    this._clock = new THREE.Clock();

    this.focusPrompt = document.getElementById('focus-prompt');
    this._reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // ---- combat juice: floating damage numbers, kill feed, goo, slow-mo ----
    this._dmgNums = [];
    this._numLayer = document.createElement('div');
    this._numLayer.id = 'fx-numbers';
    this.root.appendChild(this._numLayer);
    this._slowmoT = 0; this._slowmoCd = 0;
    // Single static hook: every enemy hit (hitscan, projectile, turret) routes here.
    Enemy.onDamage = (pos, amount, crit) => { if (this.state === 'playing') this._spawnDamageNumber(pos, amount, crit); };

    this._runPerks = []; // between-mission perks chosen this campaign run (persisted with progress)

    // Touch: build the on-screen controls and flag the document so the HUD/menus
    // adopt their touch layout. Shown only while actually playing (_setPlayInput).
    this.isTouch = detectTouch();
    if (this.isTouch) document.documentElement.classList.add('touch');
    this.touch = this.isTouch
      ? new TouchControls(root, this.input, { onPause: () => { if (this.state === 'playing') this.togglePause(); } })
      : null;

    this._bindResize();
    this._bindLock();
    this._applyQuality();
    settings.onChange(() => { this._applyQuality(); this.camera.fov = settings.data.video.fov; this.camera.updateProjectionMatrix(); });
  }

  // ---------- setup ----------
  _bindResize() {
    const onResize = () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
    };
    window.addEventListener('resize', onResize); onResize();
  }

  _bindLock() {
    this.input.onLockChange((locked) => {
      // Touch has no pointer lock, so the "click to resume" prompt never applies.
      if (!this.isTouch && this.state === 'playing' && !locked) {
        // lock loss wipes held keys — refund a primed grenade so the stale
        // "released" read can't auto-throw it while the player has no control
        if (this.player) this.player.cancelCook();
        this.focusPrompt.classList.remove('hidden');
      } else {
        this.focusPrompt.classList.add('hidden');
      }
    });
    this.canvas.addEventListener('click', () => {
      if (!this.isTouch && this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });
  }

  _applyQuality() {
    const q = this.settings.data.video.quality;
    const pr = q === 'low' ? 0.75 : q === 'medium' ? 1 : Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = this.settings.data.video.shadows && q !== 'low';
    if (this.dirLight) this.dirLight.castShadow = this.renderer.shadowMap.enabled;
    this._shadowSize = q === 'high' ? 2048 : 1024;
  }

  // ---------- mission lifecycle ----------
  startMission(index, opts = {}) {
    this.missionIndex = Math.max(0, Math.min(index, CAMPAIGN.length - 1));
    this._resume = !!opts.resume;
    if (!this._resume) clearCheckpoint(this.missionIndex); // fresh start wipes any stale checkpoint
    // run perks: a fresh start at mission 0 clears the run; otherwise load the saved set
    if (this.missionIndex === 0 && !this._resume) { this._runPerks = []; this._saveRunPerks(); }
    else { this._runPerks = loadProgress().perks || []; }
    this.state = 'missioncard';
    this._showMissionCard(CAMPAIGN[this.missionIndex]);
  }

  // Guided training, entered from the main menu. Builds a damage-free arena through
  // the normal mission pipeline, then overlays the step-by-step Tutorial. The level's
  // win/advance is suppressed (level.tutorial) so it never "completes" out from under
  // the script; the player leaves any time via Pause, which routes back to the menu.
  startTutorial() {
    this.missionIndex = 0;
    this._resume = false;
    this._runPerks = [];                     // training is a clean slate (no campaign perks)
    this._beginMission(TUTORIAL_MISSION);
    this.level.freeplay = true;              // no room win/advance — the script owns flow
    this.player.dmgTakenMult = 0;            // safe sandbox — no damage during training
    this.tutorial = new Tutorial(this.root, this, () => this.quitToMenu());
    this.tutorial.start();
  }

  // Endless Survival/Horde mode. A single arena with escalating waves owned by the
  // Survival controller; the level's win/advance is suppressed (freeplay).
  startSurvival() {
    this.missionIndex = 0;
    this._resume = false;
    this._runPerks = [];                     // Survival is its own challenge — no campaign perks
    this._beginMission(SURVIVAL_MISSION);
    this.level.freeplay = true;
    this.survival = new Survival(this.root, this, () => this.quitToMenu());
    this.survival.start();
  }

  _showMissionCard(mission) {
    this._clearResult();
    this.card = document.createElement('div');
    this.card.className = 'interactive';
    this.card.innerHTML = `
      <div class="screen">
        <div class="mission-card">
          <div class="mission-num">Mission ${this.missionIndex + 1} of ${CAMPAIGN.length}</div>
          <div class="mission-name">${mission.name}</div>
          <div class="mission-brief">${mission.brief}</div>
          ${this._runPerks.length ? `<div class="mission-perks">◆ Upgrades: ${this._runPerks.map((id) => (PERKS[id] ? PERKS[id].name : id)).join(' · ')}</div>` : ''}
          <div style="margin-bottom:20px"><span style="color:var(--ink-dim);letter-spacing:1px">DIFFICULTY:</span>
            <button class="btn ghost" data-act="diff" style="display:inline-block;padding:7px 16px;margin-left:8px">${getDifficulty(this.settings.data.difficulty).name}</button></div>
          <button class="btn primary" style="display:inline-block" data-act="go">▶ Begin Mission</button>
        </div>
      </div>`;
    this.root.appendChild(this.card);
    this.card.querySelector('[data-act="go"]').addEventListener('click', () => {
      this.audio.ensure(); this.audio.sfx('ui');
      this._beginMission(mission);
    });
    const diffBtn = this.card.querySelector('[data-act="diff"]');
    if (diffBtn) diffBtn.addEventListener('click', () => {
      this.audio.ensure(); this.audio.sfx('ui');
      const cur = DIFFICULTY_ORDER.indexOf(this.settings.data.difficulty);
      const next = DIFFICULTY_ORDER[(cur + 1) % DIFFICULTY_ORDER.length];
      this.settings.set('difficulty', next);
      diffBtn.textContent = getDifficulty(next).name;
    });
  }

  _beginMission(mission) {
    if (this.card) { this.card.remove(); this.card = null; }
    this._teardownWorld();
    this._diff = getDifficulty(this.settings.data.difficulty);

    // lighting. Outdoor fog reaches far enough that the Aureole megastructure
    // on the horizon (z ~ -260) is actually visible; interiors stay close.
    const fogFar = mission.skybox === 'interior' ? 110 : 380;
    this.scene.fog = new THREE.Fog(new THREE.Color(mission.palette.fog), 18, fogFar);
    this.scene.background = new THREE.Color(mission.palette.fog);
    this.hemi = new THREE.HemisphereLight(0xbfd6e6, new THREE.Color(mission.palette.floor), 1.0);
    this.scene.add(this.hemi);
    this.dirLight = new THREE.DirectionalLight(0xfff2dd, 1.35);
    this.dirLight.position.set(30, 60, 20);
    this.dirLight.castShadow = this.renderer.shadowMap.enabled;
    this.dirLight.shadow.mapSize.set(this._shadowSize, this._shadowSize);
    this.dirLight.shadow.camera.left = -60; this.dirLight.shadow.camera.right = 60;
    this.dirLight.shadow.camera.top = 60; this.dirLight.shadow.camera.bottom = -60;
    this.dirLight.shadow.camera.far = 200;
    this.scene.add(this.dirLight);

    // sky + signature ring
    this.sky = AssetFactory.sky(mission.skybox); this.scene.add(this.sky);
    if (mission.skybox === 'ring' || mission.skybox === 'space') { this.aureole = AssetFactory.aureole(); this.scene.add(this.aureole); }

    // level
    this.physics.clear();
    this.level = new LevelBuilder();
    let spawn = this.level.build(mission, this.physics, this._ctx());
    this.scene.add(this.level.group);

    // resume from a mid-mission checkpoint if we're retrying after death
    const cp = this._resume ? loadCheckpoint(this.missionIndex) : null;
    const fromSegment = cp ? Math.min(cp.segment, mission.segments.length - 1) : 0;
    if (cp) spawn = this.level.segmentSpawn(fromSegment);

    // player
    this.player = new Player(this.camera, spawn);
    this.player.dmgTakenMult = this._diff.dmgTaken;
    mission.startWeapons.forEach((w) => this.player.giveWeapon(w));
    this._applyPerks(this.player);                         // run perks: maxes/mults + refill
    if (cp && cp.player) this.player.applySnapshot(cp.player);
    this.player.weapons.forEach((w) => { w.reloadMult = this.player.reloadMult; }); // mirror onto (possibly rebuilt) weapons
    this._setViewModel(this.player.weapon ? this.player.weapon.key : null);

    this.enemies.length = 0; this.projectiles.length = 0; this.fx.length = 0;
    this.audio.setTrack(mission.music);
    this.hud.show(true);
    this.hud.setEscape(null);
    this.hud._subQueue = [];

    this.level.start(this._ctx(), fromSegment);
    this._resume = false;
    this._scoped = false;
    // snap any stale ADS zoom (the FOV lerp would otherwise animate it at spawn)
    this.camera.fov = this.settings.data.video.fov;
    this.camera.updateProjectionMatrix();
    this.hud.clearTransients();
    this.state = 'playing';
    this._setPlayInput(true);
    if (!this.isTouch) this.input.requestLock();
  }

  _teardownWorld() {
    if (this.tutorial) { this.tutorial.destroy(); this.tutorial = null; }
    if (this.survival) { this.survival.destroy(); this.survival = null; }
    if (this.vehicle) { this.scene.remove(this.vehicle.mesh); this.vehicle = null; }
    if (this.player) this.player.driving = false;
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = true;
    if (this.level) { this.scene.remove(this.level.group); this.level.dispose(); this.level = null; }
    for (const e of this.enemies) this.scene.remove(e.mesh);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const f of this.fx) this.scene.remove(f.mesh);
    this.enemies.length = 0; this.projectiles.length = 0; this.fx.length = 0;
    [this.hemi, this.dirLight, this.sky, this.aureole].forEach((o) => o && this.scene.remove(o));
  }

  // ---------- the shared context handed to entities ----------
  _ctx() {
    if (!this._ctxObj) {
      this._ctxObj = {
        physics: this.physics,
        audio: this.audio,
        get player() { return this._g.player; },
        get enemies() { return this._g.enemies; },
        _g: this,
        spawnEnemy: (type, pos) => { const e = new Enemy(type, pos); this._scaleEnemy(e); this.enemies.push(e); this.scene.add(e.mesh); return e; },
        requestSpawn: (type, n, near) => { const cap = 28; for (let i = 0; i < n && this.enemies.filter((x) => !x.dead).length < cap; i++) { const p = near.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)); const e = new Enemy(type, p); this._scaleEnemy(e); this.enemies.push(e); this.scene.add(e.mesh); if (this.level) { const r = this.level.segments[this.level.activeIndex]; if (r) r.enemies.push(e); } } },
        spawnProjectile: (opts) => { const pr = new Projectile(opts); this.projectiles.push(pr); this.scene.add(pr.mesh); },
        spawnTracer: (a, b) => this._spawnTracer(a, b),
        spawnImpact: (p, kind) => this._spawnImpact(p, kind),
        spawnExplosion: (p, r) => this._spawnExplosion(p, r),
        onMuzzleFlash: (def) => this._muzzle(def),
        onHitmark: () => this.hud.hitMark(),
        shake: (a) => { this.shakeAmt = Math.max(this.shakeAmt, a); },
        // '[Interact]' in prompt text is replaced with the binding (or a tap hint
        // on touch); the contextual Use button also follows the prompt.
        setPrompt: (t) => {
          if (this.touch) this.touch.setInteract(!!t);
          this.hud.setPrompt(t && t.replace('[Interact]', this.isTouch ? 'Tap USE —' : 'Press ' + codeLabel(this.settings.bindings.interact) + ' —'));
        },
        interactPressed: false,
        onObjective: (t) => this.hud.setObjective(t),
        onDialogue: (lines) => this.hud.queueDialogue(lines),
        onBanner: (a, b, s) => this.hud.banner(a, b, s),
        onEscape: (t) => this.hud.setEscape(t),
        onPickup: () => {},
        onCheckpoint: (segment) => this._saveCheckpoint(segment),
        onMountVehicle: () => this._mountVehicle(),
        onMissionComplete: () => this._missionComplete(),
        onFail: (reason) => this._missionFailed(reason),
      };
    }
    this._ctxObj.interactPressed = this.input.pressed('interact');
    return this._ctxObj;
  }

  // Enable/disable play input and mirror the on-screen touch controls' visibility
  // to it — they should be live (and visible) only while the player has control.
  _setPlayInput(on) {
    this.input.setEnabled(on);
    if (this.touch) { if (on) this.touch.show(); else this.touch.hide(); }
  }

  // ---------- pause / resume ----------
  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      if (this.player) this.player.cancelCook();
      this._setPlayInput(false);
      this.input.exitLock();
      this.focusPrompt.classList.add('hidden');
      this.hud.show(false);
      this.onPause && this.onPause();
    } else if (this.state === 'paused') {
      this.resume();
    }
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.hud.show(true);
    this._setPlayInput(true);
    if (!this.isTouch) this.input.requestLock();
    this.onResume && this.onResume();
  }
  quitToMenu() {
    this._teardownWorld();
    this.audio.stopAll();
    this.hud.show(false);
    this.state = 'menu';
    this._setPlayInput(false);
    this.input.exitLock();
    this.onQuit && this.onQuit();
  }
  restartFresh() {
    this._clearResult();
    // freeplay modes restart themselves, not a campaign mission
    if (this.survival) { this.startSurvival(); this.onResume && this.onResume(); return; }
    if (this.tutorial) { this.startTutorial(); this.onResume && this.onResume(); return; }
    clearCheckpoint(this.missionIndex); this.startMission(this.missionIndex, { resume: false }); this.onResume && this.onResume();
  }
  restartCheckpoint() { this._clearResult(); this._resume = true; this._beginMission(CAMPAIGN[this.missionIndex]); this.onResume && this.onResume(); }

  _scaleEnemy(e) {
    const h = this._diff ? this._diff.enemyHealth : 1;
    e.hp *= h; e.maxHp *= h; e.shield *= h; e.maxShield *= h;
  }

  _saveCheckpoint(segment) {
    if (!this.player) return;
    if (segment >= CAMPAIGN[this.missionIndex].segments.length) return;
    saveCheckpoint(this.missionIndex, { segment, player: this.player.snapshot() });
  }

  _mountVehicle() {
    if (this.vehicle || !this.player) return;
    this.player.cancelCook(); // pocket any primed grenade — no cooking while driving
    // Drop the transport in the MIDDLE of the arena the player just cleared (the
    // segment behind the escape track), not wherever they landed the killing blow —
    // so it always has a clean run at the exit doorway.
    const segs = this.level.segments, ai = this.level.activeIndex;
    const arena = segs[ai - 1] || segs[ai];
    const spawn = this.player.pos.clone();
    if (arena) spawn.set(arena.cx, this.player.pos.y, arena.cz);
    this.vehicle = new Vehicle(spawn, this.camera);
    this.player.pos.copy(this.vehicle.pos); // snap the player into the seat (no 1-frame jump)
    this.scene.add(this.vehicle.mesh);
    this.player.driving = true;
    if (this._viewModel) this._viewModel.visible = false;
    this.camera.fov = this.settings.data.video.fov; this.camera.updateProjectionMatrix();
    this.audio.sfx('objective');
  }

  // ---------- results ----------
  _missionComplete() {
    if (this.state === 'result') return;
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.hud.clearTransients();
    // drop a held grenade hand / mid-jab fist and restore the weapon so none
    // freeze on screen under the result banner (death/win can land mid-action)
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = !this.player.driving;
    this.audio.sfx('win');
    markCompleted(this.missionIndex);
    clearCheckpoint(this.missionIndex);
    const m = CAMPAIGN[this.missionIndex];
    const isFinaleDone = this.missionIndex >= CAMPAIGN.length - 1;
    this.hud.banner('MISSION COMPLETE', m.outro, 3);
    setTimeout(() => this._showResult(true, isFinaleDone), 2600);
  }
  _missionFailed(reason) {
    if (this.state === 'result') return;
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.hud.clearTransients();
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = !this.player.driving;
    this.audio.sfx('lose');
    this.hud.banner('DOWN', reason || 'You fell on the Aureole.', 2.5);
    setTimeout(() => this._showResult(false, false), 2200);
  }

  // ---------- between-mission perks ----------
  _applyPerks(player) {
    for (const id of this._runPerks) applyPerk(player, id);
    player.shield = player.shieldMax;          // start the mission topped up to the perked maxes
    player.health = player.healthMax;
    if (player.grenadeBonus) { player.grenades.frag += player.grenadeBonus; player.grenades.goober += player.grenadeBonus; }
  }
  _saveRunPerks() { const p = loadProgress(); p.perks = this._runPerks.slice(); saveProgress(p); }
  _choosePerk(id) {
    if (id && PERKS[id] && !this._runPerks.includes(id)) { this._runPerks.push(id); this._saveRunPerks(); }
    this.startMission(this.missionIndex + 1);
  }

  _showResult(win, finaleDone) {
    this.hud.show(false);
    this._clearResult();
    this.result = document.createElement('div');
    this.result.className = 'interactive';
    const next = this.missionIndex + 1 < CAMPAIGN.length;
    // a non-finale win offers a perk pick — 3 drawn from the unowned pool
    const perkPick = win && next && !finaleDone;
    const choices = perkPick ? PERK_IDS.filter((id) => !this._runPerks.includes(id)).sort(() => Math.random() - 0.5).slice(0, 3) : [];
    const perkSection = choices.length
      ? `<div class="perk-pick"><div class="perk-pick-head">◆ Choose an upgrade</div><div class="perk-cards">${
        choices.map((id) => `<button class="perk-card" data-perk="${id}"><b>${PERKS[id].name}</b><span>${PERKS[id].desc}</span></button>`).join('')
      }</div></div>` : '';
    this.result.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title" style="font-size:54px">${finaleDone ? 'The Halo Goes Dark' : win ? 'Mission Complete' : 'You Are Down'}</div>
          <div class="game-tag">${finaleDone ? 'Sgt. Orion rides the wreckage out. The Aureole is silent. Roll credits.' : win ? CAMPAIGN[this.missionIndex].outro : 'The Wobble Coalition will be insufferable about this.'}</div>
        </div>
        ${perkSection}
        <div class="menu-list">
          ${perkPick && !choices.length ? '<button class="btn primary" data-act="next">▶ Next Mission</button>' : ''}
          ${!win ? '<button class="btn primary" data-act="retry">↻ Retry Mission</button>' : ''}
          ${finaleDone ? '<button class="btn primary" data-act="menu">★ Finish</button>' : '<button class="btn" data-act="menu">⏏ Mission Select</button>'}
        </div>
      </div>`;
    this.root.appendChild(this.result);
    const handler = (a) => { this.audio.sfx('ui'); if (a === 'next') this.startMission(this.missionIndex + 1); else if (a === 'retry') this.restartCheckpoint(); else { this._clearResult(); this.quitToMenu(); this.onShowSelect && this.onShowSelect(); } };
    this.result.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => handler(b.dataset.act)));
    this.result.querySelectorAll('[data-perk]').forEach((b) => b.addEventListener('click', () => { this.audio.sfx('objective'); this._choosePerk(b.dataset.perk); }));
  }
  _clearResult() { if (this.result) { this.result.remove(); this.result = null; } if (this.card) { this.card.remove(); this.card = null; } }

  // ---------- FX ----------
  _spawnTracer(a, b) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.fx.push({ mesh: line, life: 0.06, maxLife: 0.06, kind: 'tracer' });
  }
  _spawnImpact(p, kind) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), new THREE.MeshBasicMaterial({ color: kind === 'spark' ? 0xffd070 : 0x9cff9c }));
    m.position.copy(p); this.scene.add(m);
    this.fx.push({ mesh: m, life: 0.18, maxLife: 0.18, kind: 'impact' });
  }
  _spawnExplosion(p, r) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85 }));
    m.position.copy(p); this.scene.add(m);
    const light = new THREE.PointLight(0xffa040, 3, r * 3); light.position.copy(p); this.scene.add(light);
    this.fx.push({ mesh: m, life: 0.35, maxLife: 0.35, kind: 'boom', r, light });
    this.shakeAmt = Math.max(this.shakeAmt, 0.3);
  }
  _muzzle(def) {
    if (!this._viewModel) return;
    const flash = AssetFactory.muzzleFlash();
    flash.position.set(0, 0.02, -0.55);
    this._viewModel.add(flash);
    this.fx.push({ mesh: flash, life: 0.05, maxLife: 0.05, kind: 'muzzle', parent: this._viewModel });
    this._muzzleLight.intensity = 9; // lights nearby walls; decays in _updatePlay
    this._vmKick = 0.12;
  }

  // First-person grenade hand: raised while cooking (trembling as the fuse
  // burns), an overhand swing on release, an instant drop on cancel.
  _updateNadeModel(dt) {
    const c = this.player.cooking;
    const ev = this.player.nadeEvent;
    this.player.nadeEvent = null;

    // instant drop on cancel / in-hand detonation
    if (ev === 'cancelled') { this._clearNadeModel(); return; }

    if (c) {
      // (re)build when there's no hand yet, the grenade type changed, or a
      // previous throw is still animating out — covers a fast re-prime inside
      // the ~0.2s throw window (otherwise the thrown model would be reused and
      // show the wrong grenade, jerking back into the cook pose)
      if (!this._nadeModel || this._nadeThrowT > 0 || this._nadeSticky !== c.sticky) {
        if (this._nadeModel) this.camera.remove(this._nadeModel);
        this._nadeModel = AssetFactory.grenadeViewModel(c.sticky);
        this._nadeModel.position.set(-0.24, -0.55, -0.5);
        this._nadeModel.rotation.y = Math.PI;
        this.camera.add(this._nadeModel);
        this._nadeSticky = c.sticky;
        this._nadeThrowT = 0;
      }
      const burn = c.sticky ? 0.2 : 1 - c.fuse / c.max;
      this._nadeModel.position.y += (-0.3 - this._nadeModel.position.y) * Math.min(1, dt * 12);
      this._nadeModel.position.x = -0.24 + (Math.random() - 0.5) * 0.022 * burn;
      return;
    }

    // no active cook: play out the overhand throw arc, then drop the hand
    if (!this._nadeModel) return;
    this._nadeThrowT += dt;
    this._nadeModel.position.z -= dt * 3.2;
    this._nadeModel.position.y += (this._nadeThrowT < 0.07 ? dt * 3 : -dt * 5);
    this._nadeModel.rotation.x -= dt * 7;
    if (this._nadeThrowT > 0.2) this._clearNadeModel();
  }

  _clearNadeModel() {
    if (this._nadeModel) { this.camera.remove(this._nadeModel); this._nadeModel = null; }
    this._nadeThrowT = 0;
  }

  // First-person fist: a quick forward jab on melee, then retract and remove.
  _updateMeleeModel(dt) {
    if (this.player.meleeEvent) {
      this.player.meleeEvent = false;
      this._meleeT = 0;
      if (!this._meleeModel) { this._meleeModel = AssetFactory.fistViewModel(); this.camera.add(this._meleeModel); }
    }
    if (!this._meleeModel) return;
    this._meleeT += dt;
    const T = 0.32, p = this._meleeT / T;
    if (p >= 1) { this._clearMeleeModel(); return; }
    const punch = Math.sin(Math.min(1, p) * Math.PI); // 0 → 1 → 0
    this._meleeModel.position.set(0.18 - punch * 0.14, -0.34 + punch * 0.16, -0.32 - punch * 0.46);
    this._meleeModel.rotation.x = -0.35 + punch * 0.35;
    this._meleeModel.rotation.z = (1 - punch) * 0.4;
  }

  _clearMeleeModel() {
    if (this._meleeModel) { this.camera.remove(this._meleeModel); this._meleeModel = null; }
    this._meleeT = 0;
  }

  _setViewModel(key) {
    if (this._vmKey === key) return;
    if (this._viewModel) this.camera.remove(this._viewModel);
    this._vmKey = key;
    if (!key) { this._viewModel = null; return; }
    this._viewModel = AssetFactory.weaponViewModel(key);
    // spawn lowered and tilted; the per-frame lerps raise it (swap feedback)
    this._viewModel.position.set(0.28, -0.62, -0.6);
    this._viewModel.rotation.x = -0.55;
    this._viewModel.rotation.y = Math.PI;
    this._muzzleLight.position.set(0, 0.02, -0.55);
    this._viewModel.add(this._muzzleLight); // re-parents from the old model
    this.camera.add(this._viewModel);
  }

  // ---------- the loop ----------
  update() {
    // controller -> virtual input (before the play step reads it this frame)
    this.input.pollGamepad();
    if (this.input._gpActive && !this._gpWasActive && this.state === 'playing') this.hud.banner('CONTROLLER', 'Gamepad connected.', 1.4);
    this._gpWasActive = this.input._gpActive;
    if (this.input.consumeGamepadPause()) {
      if (this.state === 'playing') this.togglePause();
      else if (this.state === 'paused') this.resume();
    }
    // gamepad needs no pointer lock — don't let the click-to-resume prompt block it
    if (this.input._gpActive && this.state === 'playing' && this.focusPrompt) this.focusPrompt.classList.add('hidden');

    let dt = this._clock.getDelta();
    if (dt > 0.05) dt = 0.05; // clamp big frame gaps (tab switch)

    // brief slow-mo punctuates a screen-clearing kill (real-time FX, scaled world)
    if (this._slowmoCd > 0) this._slowmoCd -= dt;
    let scale = 1;
    if (this._slowmoT > 0 && !this._reducedMotion) { this._slowmoT -= dt; scale = 0.4; }

    if (this.state === 'playing') this._updatePlay(dt * scale);
    this._updateFX(dt);

    // screen shake (suppressed for users who prefer reduced motion)
    if (this.shakeAmt > 0.001) {
      if (!this._reducedMotion) {
        this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt;
        this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt;
      }
      this.shakeAmt *= 0.86;
    }

    // bloom only while the world is actually on screen (menus/pause sit on a
    // near-opaque overlay; no point running the blur chain behind them)
    const bloom = this.settings.data.video.bloom && (this.state === 'playing' || this.state === 'result');
    if (bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // Soft aim-assist for touch on foot. The reticle stays centred and the player
  // drags to look; here we find the nearest enemy inside a screen-centre cone and
  // pull the view GENTLY toward it — stronger while firing, fading to nothing at
  // the cone's edge — so shots land without pixel-perfect thumbs. It's a nudge,
  // never a lock: the player's own drag always overrides it. Works in world
  // angles (not mouseDX) so its feel is independent of the sensitivity slider.
  _touchAssist(dt) {
    const p = this.player;
    if (!p || p.dead || !p.weapon) return;
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3();
    const CONE = 0.34;                 // NDC radius around the centred reticle
    let best = null, bestD = CONE;
    for (const e of this.enemies) {
      if (e.dead) continue;
      v.copy(e.aimPoint()).project(this.camera);
      if (v.z > 1) continue;           // behind the camera
      const d = Math.hypot(v.x, v.y);  // distance from screen centre
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return;
    const dir = new THREE.Vector3().subVectors(best.aimPoint(), p.headPoint());
    const dist = dir.length(); if (dist < 0.001) return;
    const desiredYaw = Math.atan2(dir.x, dir.z);
    const desiredPitch = Math.asin(Math.max(-1, Math.min(1, dir.y / dist)));
    let dyaw = desiredYaw - p.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const firing = this.input.isDown('fire');
    const fade = 1 - bestD / CONE;     // full strength near centre, zero at the edge
    const k = Math.min(0.5, dt * (firing ? 8 : 3) * fade);
    p.yaw += dyaw * k;
    p.pitch += (desiredPitch - p.pitch) * k;
    const lim = Math.PI / 2 - 0.02;
    p.pitch = Math.max(-lim, Math.min(lim, p.pitch));
    this.player._syncCamera(this.settings, 0); // re-aim same-frame (FOV untouched at dt 0)
  }

  _updatePlay(dt) {
    // Touch owns the 'fire' virtual (single writer): the held FIRE button or a
    // one-shot tap on the look pad. Set it BEFORE beginFrame so a tap registers
    // as a pressed-edge this frame for semi-auto weapons (and for the turret).
    if (this.isTouch && this.touch) {
      const fire = this.touch.fireHeld || this.touch.tapFire;
      this.touch.tapFire = false;
      this.input.setVirtual('fire', fire);
    }
    this.input.beginFrame();
    const ctx = this._ctx();

    // ADS flag for FOV zoom + scope overlay (scoped weapons only, on foot only)
    this.settings._adsActive = this.input.isDown('ads') && this.player.weapon != null;
    const scoped = !!(this.settings._adsActive && !this.player.driving
      && this.player.weapon && this.player.weapon.def.scoped);
    if (scoped !== this._scoped) { this._scoped = scoped; this.audio.sfx(scoped ? 'scopein' : 'scopeout'); }

    this.player.update(dt, this.input, this.settings, ctx);
    if (this.vehicle) {
      this.vehicle.update(dt, this.input, ctx);   // drag-look moves the turret reticle (mouseDX)
      this.player.pos.copy(this.vehicle.pos);
    } else if (this.isTouch) {
      this._touchAssist(dt);                       // soft aim magnetism off the centred reticle
    }
    // touch QoL: auto-reload a dry magazine
    if (this.isTouch && this.player.weapon && this.player.weapon.needsReload() && this.player.weapon.reloading <= 0) {
      if (this.player.weapon.startReload()) this.audio.sfx('reload');
    }
    this._setViewModel(this.player.weapon ? this.player.weapon.key : null);
    this._updateNadeModel(dt);
    this._updateMeleeModel(dt);

    // weapon viewmodel kick + sway (hidden while scoped, punching, or holding a grenade)
    if (this._viewModel) {
      this._viewModel.visible = !scoped && !this.player.driving && !this._nadeModel && !this._meleeModel;
      // reload pose: dip the gun down and roll it in toward the magazine,
      // following the reload timer so it eases out and back on its own
      const w = this.player.weapon;
      let dip = 0, roll = 0;
      if (w && w.reloading > 0) {
        const p = Math.max(0, Math.min(1, 1 - w.reloading / w.def.reloadTime));
        const s = Math.sin(p * Math.PI);
        dip = s * 0.22; roll = s * 0.6;
      }
      const target = -0.6 - (this._vmKick || 0);
      this._viewModel.position.z += (target - this._viewModel.position.z) * Math.min(1, dt * 18);
      if (this._vmKick) this._vmKick = Math.max(0, this._vmKick - dt * 0.8);
      const adsing = this.settings._adsActive;
      this._viewModel.position.x += ((adsing ? 0.0 : 0.28) - this._viewModel.position.x) * Math.min(1, dt * 10);
      this._viewModel.position.y += (((adsing ? -0.16 : -0.26) - dip) - this._viewModel.position.y) * Math.min(1, dt * 10);
      this._viewModel.rotation.x += (0 - this._viewModel.rotation.x) * Math.min(1, dt * 10);
      this._viewModel.rotation.z += (roll - this._viewModel.rotation.z) * Math.min(1, dt * 12);
    }
    if (this._muzzleLight.intensity > 0) this._muzzleLight.intensity = Math.max(0, this._muzzleLight.intensity - dt * 200);

    // play audio for damage events
    const hs = this.player.hudState();
    hs.scoped = scoped;
    hs.scopeZoom = scoped ? this.player.weapon.def.adsZoom : 0;
    hs.driving = this.player.driving;
    if (hs.dmgSfx) this.audio.sfx(hs.dmgSfx);

    // enemies
    for (const e of this.enemies) { e.update(dt, ctx); if (e.dead && !e._killHandled) { e._killHandled = true; this._onEnemyKilled(e); } }
    // cull finished-dead enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead && e.deathT <= 0) {
        if (!e._counted) { e._counted = true; if (Math.random() < 0.25) this._maybeDrop(e); }
        this.scene.remove(e.mesh); this.enemies.splice(i, 1);
      }
    }

    // projectiles
    for (const p of this.projectiles) p.update(dt, ctx);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].dead) { this.scene.remove(this.projectiles[i].mesh); this.projectiles.splice(i, 1); }
    }

    // level flow
    this.level.update(dt, this.player, ctx);
    if (this.tutorial) this.tutorial.update(dt);
    if (this.survival) this.survival.update(dt);

    // signature ring drift
    if (this.aureole) this.aureole.rotation.z += dt * 0.01;

    // HUD
    this.hud.update(dt, hs, this.enemies, this.player);
    this.hud.setTurret(this.vehicle ? { x: this.vehicle.aim.x, y: this.vehicle.aim.y, locked: !!this.vehicle.lockedTarget } : null);

    // player death (Survival runs its own game-over; campaign rooms use onFail)
    if (this.player.dead && this.state === 'playing' && !this.survival) ctx.onFail('Sgt. Orion is down. The eulogy will have to wait.');

    this.input.endFrame();
  }

  _maybeDrop() { /* reserved: could drop ammo on kill; kept light for balance */ }

  _updateFX(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const t = Math.max(0, f.life / f.maxLife);
      if (f.kind === 'tracer' || f.kind === 'impact' || f.kind === 'muzzle') { if (f.mesh.material) f.mesh.material.opacity = t; }
      if (f.kind === 'boom') { const s = 1 + (1 - t) * f.r; f.mesh.scale.setScalar(s); f.mesh.material.opacity = t * 0.85; if (f.light) f.light.intensity = 3 * t; }
      if (f.kind === 'goo') {
        f.vel.y -= 18 * dt;
        f.mesh.position.addScaledVector(f.vel, dt);
        if (f.mesh.position.y < 0.08) { f.mesh.position.y = 0.08; f.vel.set(0, 0, 0); }
        if (f.mesh.material) f.mesh.material.opacity = Math.min(0.9, t * 1.4);
      }
      if (f.life <= 0) {
        if (f.parent) f.parent.remove(f.mesh); else this.scene.remove(f.mesh);
        if (f.light) this.scene.remove(f.light);
        this.fx.splice(i, 1);
      }
    }
    this._updateDamageNumbers(dt);
  }

  // ---- combat juice ----------------------------------------------------------
  _onEnemyKilled(e) {
    this.hud.killFeed(e.meta.name, e.meta.scoreColor);
    this._spawnGoo(e.pos, e.meta.scoreColor);
    if (this.player && this.player.healOnKill && !this.player.dead && !e._noSiphon) this.player.addHealth(this.player.healOnKill); // perk: Goo Siphon (earned kills only)
    if (this.enemies.filter((x) => !x.dead).length === 0) this._triggerSlowmo(); // screen-clearing kill
  }

  _triggerSlowmo() {
    if (this._reducedMotion || this._slowmoCd > 0) return;
    this._slowmoT = 0.55; this._slowmoCd = 3.0;
  }

  _spawnGoo(pos, color) {
    if (this._reducedMotion) return;
    const c = color || 0x9cff9c;
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.08 + Math.random() * 0.1, 6, 5),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }));
      m.position.set(pos.x, pos.y + 1.0, pos.z);
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4.5;
      const vel = new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 3.5, Math.sin(a) * sp);
      this.fx.push({ mesh: m, life: 0.55 + Math.random() * 0.35, maxLife: 0.9, kind: 'goo', vel });
    }
  }

  _spawnDamageNumber(worldPos, amount, crit) {
    if (this._reducedMotion) return;
    const el = document.createElement('div');
    el.className = 'dmgnum' + (crit ? ' crit' : '');
    el.textContent = Math.max(1, Math.round(amount)) + (crit ? '!' : '');
    this._numLayer.appendChild(el);
    this._dmgNums.push({ el, pos: worldPos.clone(), life: 0.8, maxLife: 0.8, vy: 1.6 + Math.random() * 0.6, dx: (Math.random() - 0.5) * 18 });
    if (this._dmgNums.length > 40) { const old = this._dmgNums.shift(); old.el.remove(); }
  }

  _updateDamageNumbers(dt) {
    if (!this._dmgNums.length) return;
    const v = new THREE.Vector3();
    for (let i = this._dmgNums.length - 1; i >= 0; i--) {
      const n = this._dmgNums[i];
      n.life -= dt;
      if (n.life <= 0) { n.el.remove(); this._dmgNums.splice(i, 1); continue; }
      n.pos.y += n.vy * dt;                                  // float up in world space
      v.copy(n.pos).project(this.camera);
      if (v.z > 1) { n.el.style.opacity = '0'; continue; }   // behind the camera
      const x = (v.x * 0.5 + 0.5) * window.innerWidth + n.dx * (1 - n.life / n.maxLife);
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      n.el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
      n.el.style.opacity = String(Math.min(1, (n.life / n.maxLife) * 1.6));
    }
  }
}
