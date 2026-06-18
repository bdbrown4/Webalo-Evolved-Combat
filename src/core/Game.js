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
import { Player, COOP } from '../entities/Player.js';
import { Enemy } from '../entities/Enemy.js';
import { Projectile } from '../entities/Projectile.js';
import { Vehicle } from '../entities/Vehicle.js';
import { LevelBuilder } from '../world/LevelBuilder.js';
import { AssetFactory } from './AssetFactory.js';
import { getDifficulty, DIFFICULTY_ORDER } from './Difficulty.js';
import { codeLabel } from './Settings.js';
import { GAMEPAD_BUTTONS } from './Input.js';
import { PERKS, PERK_IDS, applyPerk } from './Perks.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { Tutorial, TUTORIAL_MISSION } from '../ui/Tutorial.js';
import { Survival, SURVIVAL_MISSION } from '../ui/Survival.js';
import { CAMPAIGN, markCompleted, loadCheckpoint, saveCheckpoint, clearCheckpoint, loadProgress, saveProgress } from '../missions/campaign.js';
import { serializeSnapshot, applySnapshot, serializeInput, NetInputProxy, interpolateGhosts, clearGhosts, withSeededRandom, NET_SNAP_DT, NET_INPUT_DT, serializePvpSnap, applyPvpSnap, interpPvp, clearPvpAvatars, pvpColor } from '../net/CoopSync.js';
import { hostTrystero, joinTrystero, createManual, makeRoomCode } from '../net/Net.js';
import { combineMods, noMods, MUTATORS } from './Mutators.js';
import { saveDailyBest, makeShareCode } from './Daily.js';

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
    this.players = [];          // all players in the world; [local] solo, [local, remote…] in co-op
    this.net = null; this.coopRole = null;   // 'host' | 'guest' while a co-op session is live
    this._coopMode = 'survival';             // 'survival' | 'campaign' — what a co-op session plays
    this._pvp = null;                        // { fragLimit, over } while a Deathmatch is live
    this._guestRunPerks = [];                // co-op campaign: guest's chosen perks (host applies on rebuild)
    this._pendingGuestPerk = null;           // a perk the guest picked, awaiting the host's next advance
    this._hostPendingPerk = null;            // the host's pick on the current mission-complete screen
    this._ghosts = new Map();                // guest: enemy id -> { mesh, target } ghosts
    this._projGhosts = new Map();            // guest: projectile id -> { mesh } ghosts
    this._netEvents = [];                    // host: one-shot events queued for the next snapshot
    this._netSnapAccum = 0; this._netInputAccum = 0; this._netSeq = 0; this._guestFireCd = 0;
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
    this._mutators = []; this._mods = noMods();   // active run modifiers (Daily Challenge / custom)
    this._daily = null;                           // { key, mode } while a Daily Challenge run is live

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

  // ---------- run modifiers (mutators / daily) ----------
  // Set the active mutator list (and its folded effect object) for the next run.
  // Always called on a run's entry point so a previous mutated/daily run can't bleed
  // into a normal one.
  _setRunMods(ids) { this._mutators = (ids || []).slice(); this._mods = combineMods(this._mutators); }
  _modBanner() {
    if (!this._mutators.length) return;
    const names = this._mutators.map((id) => (MUTATORS[id] ? MUTATORS[id].icon + ' ' + MUTATORS[id].name : id)).join(' · ');
    this.hud && this.hud.banner('MODIFIERS', names, 2.6);
  }

  // ---------- mission lifecycle ----------
  startMission(index, opts = {}) {
    this.missionIndex = Math.max(0, Math.min(index, CAMPAIGN.length - 1));
    this._resume = !!opts.resume;
    this._setRunMods(opts.mutators);
    this._levelSeed = opts.seed || undefined;            // daily: deterministic arena
    this._daily = opts.daily || null;
    if (!this._resume) clearCheckpoint(this.missionIndex); // fresh start wipes any stale checkpoint
    // run perks: a fresh start at mission 0 clears the run; otherwise load the saved set.
    // a Daily mission is its own one-shot — no campaign perks carried in.
    if (this._daily) { this._runPerks = []; }
    else if (this.missionIndex === 0 && !this._resume) { this._runPerks = []; this._saveRunPerks(); }
    else { this._runPerks = loadProgress().perks || []; }
    // a Daily mission skips the card (fixed difficulty, no perks) and drops straight in
    if (this._daily) { this._beginMission(CAMPAIGN[this.missionIndex]); return; }
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
    this._setRunMods([]); this._daily = null; this._levelSeed = undefined;
    this._beginMission(TUTORIAL_MISSION);
    this.level.freeplay = true;              // no room win/advance — the script owns flow
    this.player.dmgTakenMult = 0;            // safe sandbox — no damage during training
    this.tutorial = new Tutorial(this.root, this, () => this.quitToMenu());
    this.tutorial.start();
  }

  // Endless Survival/Horde mode. A single arena with escalating waves owned by the
  // Survival controller; the level's win/advance is suppressed (freeplay). opts carry
  // the Daily Challenge's seed + mutators (omitted for a normal run).
  startSurvival(opts = {}) {
    this.missionIndex = 0;
    this._resume = false;
    this._runPerks = [];                     // Survival is its own challenge — no campaign perks
    this._setRunMods(opts.mutators);
    this._levelSeed = opts.seed || undefined;
    this._daily = opts.daily || null;
    this._beginMission(SURVIVAL_MISSION);
    this.level.freeplay = true;
    // dev rig: ?coopdummy=1 drops a second, AI-wandering player so the co-op
    // targeting/avatar/damage paths can be exercised before networking exists
    if (this._coopDummy()) { const s = this.player.pos.clone(); s.x += 4; const d = this.addRemotePlayer(s, { color: 0xff8a3d }); d._dummy = true; }
    this.survival = new Survival(this.root, this, () => this.quitToMenu());
    this.survival.start();
  }

  // ---------- Daily Challenge ----------
  // ch is a dailyChallenge() object. Survival is a seeded horde run; Mission is a
  // rotating campaign mission. Both carry the day's mutators and record a daily best.
  startDailySurvival(ch) {
    this.startSurvival({ seed: ch.survival.seed, mutators: ch.survival.mutators, daily: { key: ch.key, mode: 'survival', seed: ch.survival.seed, mutators: ch.survival.mutators } });
  }
  startDailyMission(ch) {
    const d = { key: ch.key, mode: 'mission', index: ch.mission.index, seed: ch.mission.seed, mutators: ch.mission.mutators };
    this.startMission(ch.mission.index, { seed: ch.mission.seed, mutators: ch.mission.mutators, daily: d });
  }
  _replayDaily() {
    const d = this._daily; if (!d) return;
    if (d.mode === 'survival') this.startSurvival({ seed: d.seed, mutators: d.mutators, daily: d });
    else this.startMission(d.index, { seed: d.seed, mutators: d.mutators, daily: d });
  }
  // Fold a finished daily run into the day's best and stash a shareable result.
  _recordDaily(score) {
    const d = this._daily; if (!d) return null;
    const s = Math.max(0, Math.round(score));
    const best = saveDailyBest(d.key, d.mode, { score: s, at: Date.now() });
    this._lastDaily = { key: d.key, mode: d.mode, score: s, best: best.score, code: makeShareCode(d.key, d.mode, s) };
    return this._lastDaily;
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
    // Daily Challenges are the same for everyone, so they run at a fixed difficulty
    // (the day's mutators are the variable, not the tier).
    this._diff = getDifficulty(this._daily ? 'trooper' : this.settings.data.difficulty);
    this.physics.gravity = -22 * this._mods.gravity;       // mutators: world gravity (jumps + ragdolls)
    this._dailyKills = 0; this._dailyStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
    // Co-op: build the arena under a shared seed so host and guest get byte-identical
    // geometry (cover, dimensions) — the only part of the world both sides generate.
    let spawn = this._levelSeed
      ? withSeededRandom(this._levelSeed, () => this.level.build(mission, this.physics, this._ctx()))
      : this.level.build(mission, this.physics, this._ctx());
    this.scene.add(this.level.group);

    // resume from a mid-mission checkpoint if we're retrying after death
    const cp = this._resume ? loadCheckpoint(this.missionIndex) : null;
    const fromSegment = cp ? Math.min(cp.segment, mission.segments.length - 1) : 0;
    if (cp) spawn = this.level.segmentSpawn(fromSegment);

    // player
    this.player = new Player(this.camera, spawn);
    this.player.dmgTakenMult = this._diff.dmgTaken * this._mods.playerDmgTaken;   // mutators
    mission.startWeapons.forEach((w) => this.player.giveWeapon(w));
    this._applyPerks(this.player);                         // run perks: maxes/mults + refill
    // mutators: scale the marine's max health (after perks set the perked max), top up
    if (this._mods.playerHealthMax !== 1) { this.player.healthMax = Math.max(1, Math.round(this.player.healthMax * this._mods.playerHealthMax)); this.player.health = this.player.healthMax; }
    if (cp && cp.player) this.player.applySnapshot(cp.player);
    this.player.weapons.forEach((w) => { w.reloadMult = this.player.reloadMult; }); // mirror onto (possibly rebuilt) weapons
    this._setViewModel(this.player.weapon ? this.player.weapon.key : null);
    this.players = [this.player];                          // co-op adds remote players on top of this

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
    this._modBanner();                       // announce active mutators (no-op for a clean run)
    if (!this.isTouch) this.input.requestLock();
  }

  _teardownWorld() {
    if (this.tutorial) { this.tutorial.destroy(); this.tutorial = null; }
    if (this.survival) { this.survival.destroy(); this.survival = null; }
    if (this.vehicle) { this.scene.remove(this.vehicle.mesh); this.vehicle = null; }
    if (this.player) this.player.driving = false;
    for (const p of this.players) { if (p !== this.player && p._avatar) this.scene.remove(p._avatar); }
    this.players = [];
    clearGhosts(this);
    this._clearVehGhost();
    this._pvp = null; this._pvpNetState = null; this._clearPvpHud();
    clearPvpAvatars(this); this._pvpMe = null; this._pvpBoard = null; this._pvpGuests = null; this._myId = null;
    this._clearCoopHud();
    if (this._hostAvatar) { this.scene.remove(this._hostAvatar); this._hostAvatar = null; }
    if (this._svHudEl) { this._svHudEl.remove(); this._svHudEl = null; }
    this._guestNetState = null; this._svNetState = null; this._guestPlayer = null; this._netEvents.length = 0;
    this._hostState = null; this._coopOver = false;
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
        get players() { return this._g.players; },
        get enemies() { return this._g.enemies; },
        // The living player nearest a world point — how enemies/projectiles pick a
        // co-op target. Solo, this is always the one player (or null if downed).
        nearestPlayer: (pos) => { let best = null, bd = Infinity; for (const pl of this.players) { if (!pl || pl.dead || pl.downed) continue; const d = pl.pos.distanceToSquared(pos); if (d < bd) { bd = d; best = pl; } } return best; },
        // who a shooter may hit: enemies in PvE, or the opposing player(s) in PvP.
        combatTargets: (shooter) => this._combatTargets(shooter),
        _g: this,
        spawnEnemy: (type, pos) => { const e = new Enemy(type, pos); this._scaleEnemy(e); this.enemies.push(e); this.scene.add(e.mesh); return e; },
        requestSpawn: (type, n, near) => { const cap = 28; for (let i = 0; i < n && this.enemies.filter((x) => !x.dead).length < cap; i++) { const p = near.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)); const e = new Enemy(type, p); this._scaleEnemy(e); this.enemies.push(e); this.scene.add(e.mesh); if (this.level) { const r = this.level.segments[this.level.activeIndex]; if (r) r.enemies.push(e); } } },
        spawnProjectile: (opts) => { const pr = new Projectile(opts); this.projectiles.push(pr); this.scene.add(pr.mesh); },
        spawnTracer: (a, b) => this._spawnTracer(a, b),
        spawnImpact: (p, kind) => this._spawnImpact(p, kind),
        spawnExplosion: (p, r) => { this._spawnExplosion(p, r); this._netPush('expl', p.x, p.y, p.z, r); },
        onTelegraph: (p, radius, duration, color) => { this._spawnTelegraph(p, radius, duration, color); this._netPush('tel', p.x, p.z, radius, duration, color || 0xff5a5a); },
        onMuzzleFlash: (def) => this._muzzle(def),
        onHitmark: () => this.hud.hitMark(),
        // co-op turret: spawn the tracer + report + hitmark locally AND mirror them to
        // the guest gunner (who's actually aiming it) so their shots read on their screen.
        onTurretFire: (a, b, hit) => {
          this._spawnTracer(a, b); this.audio.sfx('rifle'); if (hit) this.hud.hitMark();
          const rt = (n) => Math.round(n * 100) / 100;
          this._netPush('vfire', rt(a.x), rt(a.y), rt(a.z), rt(b.x), rt(b.y), rt(b.z), hit ? 1 : 0);
        },
        shake: (a) => { this.shakeAmt = Math.max(this.shakeAmt, a); },
        // '[Interact]' in prompt text is replaced with the binding (or a tap hint
        // on touch); the contextual Use button also follows the prompt.
        setPrompt: (t) => {
          if (this.touch) this.touch.setInteract(!!t);
          this.hud.setPrompt(t && t.replace('[Interact]', (this.isTouch ? 'Tap ' : 'Press ') + this._ctrlKey('interact', 'USE') + ' —'));
        },
        interactPressed: false,
        onObjective: (t) => { this.hud.setObjective(t); this._netPush('obj', t); },
        onDialogue: (lines) => this.hud.queueDialogue(lines),
        onBanner: (a, b, s) => { this.hud.banner(a, b, s); this._netPush('banner', a, b, s); },
        // escape timer: mirror to the guest, but only when the whole-second readout
        // changes (it ticks every frame) so we don't flood the event queue at 20Hz.
        onEscape: (t) => { this.hud.setEscape(t); const s = t == null ? null : Math.ceil(t); if (this.coopRole === 'host' && s !== this._lastEscPush) { this._lastEscPush = s; this._netPush('esc', s); } },
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

  // The control label for an action, matched to the device the player is actually
  // using right now: touch → the on-screen label, controller → the pad button,
  // otherwise the keyboard/mouse binding.
  _ctrlKey(action, touchLabel) {
    if (this.isTouch) return touchLabel;
    if (this.input.lastSource === 'pad') return GAMEPAD_BUTTONS[action] || action;
    return codeLabel(this.settings.bindings[action]);
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
    // null the role/net BEFORE closing so our own close doesn't read as "partner left"
    const net = this.net; this.net = null; this.coopRole = null; this._levelSeed = undefined; this._coopLeft = false; this._coopOver = false; this._daily = null; this._pvp = null;
    if (net) { try { net.close(); } catch (e) { /* already gone */ } }
    if (this._pendingNet) { try { this._pendingNet.close(); } catch (e) { /* gone */ } this._pendingNet = null; }
    this._clearCoopOverlay();
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
    // co-op is host-authoritative: the host rebuilds the current mission for both;
    // a guest can't restart on its own, so it just resumes (host owns the restart).
    if (this.coopRole === 'host') { this._coopBuildMission(); this.onResume && this.onResume(); return; }
    if (this.coopRole === 'guest') { this.onResume && this.onResume(); return; }
    // a Daily Challenge restarts the exact same seed + mutators
    if (this._daily) { this._replayDaily(); this.onResume && this.onResume(); return; }
    // freeplay modes restart themselves, not a campaign mission
    if (this.survival) { this.startSurvival(); this.onResume && this.onResume(); return; }
    if (this.tutorial) { this.startTutorial(); this.onResume && this.onResume(); return; }
    clearCheckpoint(this.missionIndex); this.startMission(this.missionIndex, { resume: false }); this.onResume && this.onResume();
  }
  restartCheckpoint() { this._clearResult(); this._resume = true; this._beginMission(CAMPAIGN[this.missionIndex]); this.onResume && this.onResume(); }

  _scaleEnemy(e) {
    const h = (this._diff ? this._diff.enemyHealth : 1) * this._mods.enemyHealth;   // difficulty × mutators
    e.hp *= h; e.maxHp *= h; e.shield *= h; e.maxShield *= h;
    e.speed *= this._mods.enemySpeed;
  }

  // ---------- co-op: remote players ----------
  _coopDummy() { try { return new URLSearchParams(location.search).get('coopdummy') === '1'; } catch (e) { return false; } }

  // A second (or third…) player that this client does not control directly: on the
  // host it's the guest driven by networked input; the dev dummy wanders on its own.
  // It's a full Player (so enemies/projectiles damage it through the same paths) but
  // owns a throwaway camera so it never touches our real view, and carries a visible
  // "buddy" avatar (the local player stays first-person/invisible).
  addRemotePlayer(spawn, opts = {}) {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
    const p = new Player(cam, spawn);
    p.remote = true;
    p.netId = opts.id || 'guest';
    p.dmgTakenMult = this._diff ? this._diff.dmgTaken : 1;
    (opts.weapons || ['rifle', 'pistol']).forEach((w) => p.giveWeapon(w));
    // co-op campaign: the guest carries its own run perks (host-authoritative, so the
    // host applies them to the simulated guest player and tops it up to the new maxes)
    (opts.perks || []).forEach((id) => applyPerk(p, id));
    p.shield = p.shieldMax; p.health = p.healthMax;
    p._avatar = this._makeBuddyAvatar(opts.color);
    p._avatar.position.copy(p.pos);
    this.scene.add(p._avatar);
    this.players.push(p);
    return p;
  }

  _makeBuddyAvatar(color) {
    const g = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color: color || 0x3d7bd6, metalness: 0.3, roughness: 0.6 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.7, 4, 10), armor);
    torso.position.y = 1.0; torso.castShadow = true; g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), armor);
    head.position.y = 1.62; head.castShadow = true; g.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.09),
      new THREE.MeshStandardMaterial({ color: 0x8ffcff, emissive: 0x2bd6ff, emissiveIntensity: 0.8, metalness: 0.4, roughness: 0.3 }));
    visor.position.set(0, 1.64, 0.22); g.add(visor);
    // a stubby rifle nub pointing +Z (forward at yaw 0) so the buddy's facing reads
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.6, roughness: 0.4 }));
    gun.position.set(0.26, 1.0, 0.34); g.add(gun);
    return g;
  }

  // Advance a non-local player. The dev dummy ambles in a slow circle; the networked
  // guest (Slice 3) will instead be driven from forwarded input. Either way we keep
  // its shields/weapons ticking and sync its avatar to its transform.
  _updateRemotePlayer(rp, dt, ctx) {
    if (!rp.dead && rp._dummy) {
      rp._wanderT = (rp._wanderT || 0) + dt;
      rp.yaw = rp._wanderT * 0.6;
      const fwd = new THREE.Vector3(Math.sin(rp.yaw), 0, Math.cos(rp.yaw));
      rp.vel.x = fwd.x * 2.5; rp.vel.z = fwd.z * 2.5;
      rp.vel.y += ctx.physics.gravity * dt;
      const res = ctx.physics.moveAndCollide(rp.pos, rp.vel, dt, rp.radius, rp.curHeight);
      if (res.grounded && rp.vel.y < 0) rp.vel.y = 0;
      rp._regen(dt, ctx);
      if (rp.weapon) rp.weapon.update(dt);
    } else if (!rp.dead && rp._netInput) {
      // Networked guest: trust the latest packet's transform, then run combat-only
      // (Player.update remote branch) so the host resolves the guest's shots/etc.
      const pkt = rp._netInput.latest;
      // a co-op gunner rides the vehicle — its position is owned by the Vehicle, not
      // its reported transform — so only take its look (drives the turret aim).
      if (pkt) { if (!rp._gunner) rp.pos.set(pkt.x, pkt.y, pkt.z); rp.yaw = pkt.yaw; rp.pitch = pkt.pitch; if (pkt.h) rp.curHeight = pkt.h; }
      rp._netInput.beginFrame();
      rp.update(dt, rp._netInput, this.settings, ctx);
    }
    this._syncAvatar(rp);
  }

  _syncAvatar(rp) {
    if (!rp._avatar) return;
    rp._avatar.visible = !rp.dead;
    rp._avatar.position.set(rp.pos.x, rp.pos.y, rp.pos.z);
    rp._avatar.rotation.y = rp.yaw;
  }

  // ---------- co-op: session start ----------
  // queue a one-shot event for the next snapshot (no-op unless we're the host)
  _netPush(k, ...d) { if (this.coopRole === 'host') this._netEvents.push([k, ...d]); }

  // HOST: called once the guest's transport connects. Wires the one-time net handlers,
  // then builds the first mission (Survival arena, or campaign mission 0). Subsequent
  // rebuilds — shared retries and campaign advances — go straight to _coopBuildMission.
  startCoopHost(net) {
    this.net = net; this.coopRole = 'host';
    this._coopOver = false; this._coopLeft = false;
    this._runPerks = []; this._guestRunPerks = []; this._pendingGuestPerk = null; this._hostPendingPerk = null;
    this.missionIndex = 0; this._lastEscPush = null;
    net.on('input', (pkt) => { if (this._guestPlayer && this._guestPlayer._netInput) this._guestPlayer._netInput.feed(pkt); });
    net.on('retryReq', () => { if (this._coopOver) this._coopRetry(); });
    net.on('guestPerk', (id) => { this._pendingGuestPerk = id; });        // campaign: guest's between-mission pick
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
    this._coopBuildMission();
  }

  // HOST: build (or rebuild) the CURRENT co-op mission under a fresh shared seed, drop
  // the guest in beside us, and ship 'start' so the guest builds the matching world.
  // Reused for the initial launch, a shared retry, and a campaign mission advance.
  _coopBuildMission() {
    this._coopOver = false; this._coopLeft = false; this._lastEscPush = null;
    this._levelSeed = (Date.now() & 0x7fffffff) || 1;
    this._resume = false;
    this._setRunMods([]); this._daily = null;       // co-op runs aren't mutated/daily

    const campaign = this._coopMode === 'campaign';
    if (campaign) {
      this._beginMission(CAMPAIGN[this.missionIndex]);             // win/advance handled by the level
    } else {
      this.missionIndex = 0; this._runPerks = [];
      this._beginMission(SURVIVAL_MISSION);
      this.level.freeplay = true;
    }
    const gs = this.player.pos.clone(); gs.x += 4;                 // guest spawns beside the host
    // arm the simulated guest with the mission's loadout so the host resolves the
    // guest's shots with the SAME weapon the guest sees locally (campaign loadouts vary)
    const guestWeapons = campaign ? CAMPAIGN[this.missionIndex].startWeapons.slice() : ['rifle', 'pistol'];
    const guest = this.addRemotePlayer(gs, { color: 0xffb454, id: 'guest', weapons: guestWeapons, perks: campaign ? this._guestRunPerks : [] });
    guest._netInput = new NetInputProxy();
    this._guestPlayer = guest;
    this.player.downable = true; guest.downable = true;            // co-op: 0 HP downs, doesn't kill
    this.net.send('start', { seed: this._levelSeed, gs: { x: gs.x, y: gs.y, z: gs.z }, mode: this._coopMode, mi: this.missionIndex, gPerks: this._guestRunPerks });
    if (!campaign) { this.survival = new Survival(this.root, this, () => this.quitToMenu()); this.survival.start(); }
  }

  // GUEST: register handlers as soon as we join; the world is built when the host's
  // 'start' arrives (so we use its seed), then snapshots drive everything.
  joinCoop(net) {
    this.net = net; this.coopRole = 'guest';
    this._coopOver = false; this._coopLeft = false;
    net.on('start', (d) => this._beginCoopGuest(d));
    net.on('snap', (snap) => { this._lastSnap = snap; applySnapshot(this, snap); });
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
  }

  _beginCoopGuest(d) {
    // each 'start' (re)builds the world — initial join, co-op retries, AND campaign
    // mission advances all arrive here, carrying the host's mode/seed/mission index.
    this._netClock = 0;
    this._levelSeed = d.seed;
    this._coopMode = d.mode || 'survival';
    this._resume = false; this._runPerks = [];
    this._setRunMods([]); this._daily = null;
    const campaign = this._coopMode === 'campaign';
    this.missionIndex = campaign ? (d.mi || 0) : 0;
    this._guestRunPerks = d.gPerks || [];                          // mirrors the host's view of our perks
    this._beginMission(campaign ? CAMPAIGN[this.missionIndex] : SURVIVAL_MISSION);
    if (!campaign) this.level.freeplay = true;
    if (d.gs) { this.player.pos.set(d.gs.x, d.gs.y, d.gs.z); this.player._syncCamera(this.settings, 0); }
    this._hostAvatar = this._makeBuddyAvatar(0x3d7bd6);            // the host, drawn from snapshots
    this.scene.add(this._hostAvatar);
    if (!campaign) this._initGuestSurvivalHud();
    this._clearCoopOverlay();
    this._clearResult();                                          // drop any lingering mission-complete screen
  }

  // ---------- co-op: lobby / connection ----------
  _showCoopOverlay(html) {
    this._clearCoopOverlay();
    const el = document.createElement('div');
    el.className = 'interactive coop-overlay';
    el.innerHTML = `<div class="screen"><div class="coop-panel">${html}</div></div>`;
    this.root.appendChild(el);
    this._coopOverlayEl = el;
    return el;
  }
  _clearCoopOverlay() { this._coopClearTimers(); if (this._coopOverlayEl) { this._coopOverlayEl.remove(); this._coopOverlayEl = null; } }
  _coopCancel(net) { try { net && net.close(); } catch (e) { /* gone */ } this._pendingNet = null; this._clearCoopOverlay(); this.onQuit && this.onQuit(); }

  // HOST over Trystero relays: show a room code, wait for the guest, then begin.
  coopHost(mode) {
    this._coopMode = mode || 'survival';
    const where = this._coopMode === 'campaign' ? 'New Campaign' : 'Survival';
    const code = makeRoomCode();
    const net = hostTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Hosting ${this._coopMode === 'campaign' ? 'Campaign' : 'Survival'} Co-op</div>
      <div class="coop-sub">Send this code to your friend — they open <b>${where}</b> and pick <b>Join</b>:</div>
      <div class="coop-code">${code}</div>
      <button class="btn" data-act="copy">⧉ Copy Code</button>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Waiting for a friend to join…</span></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    const copyBtn = el.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy Code'; }, 1200); } catch (e) {} });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    net.onState((s) => {
      if (s === 'connected' && this.coopRole !== 'host') {
        this._coopSetStatus(el, 'Friend connected! Launching…', true);
        this._coopLaunchTimer = setTimeout(() => { this._pendingNet = null; this._clearCoopOverlay(); this.startCoopHost(net); }, 700);
      }
    });
  }

  // JOIN over Trystero relays: enter the host's code, connect, wait for 'start'.
  // The authoritative mode comes from the host's 'start' packet; this is just a hint.
  coopJoin(code, mode) {
    this._coopMode = mode || 'survival';
    const net = joinTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Joining ${code}</div>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Reaching your friend…</span></div>
      <div class="coop-dim">Peer-to-peer can take a few seconds to link up.</div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    this.joinCoop(net);
    // reassure after a beat, fail clearly if it never links up
    this._coopReassure = setTimeout(() => this._coopSetStatus(el, 'Still linking… hang tight (relays can be slow).'), 5000);
    this._coopFailTimer = setTimeout(() => { if (!this.level) this._coopFail(el, net, 'Couldn’t reach the host. Double-check the code and that they’re still hosting — or try Manual connect.'); }, 25000);
    net.onState((s) => { if (s === 'connected') this._coopSetStatus(el, 'Connected! Starting…', true); });
  }

  _coopSetStatus(el, text, ok) {
    const st = el && el.querySelector('.coop-status'); if (st) st.textContent = text;
    if (ok) { const sp = el.querySelector('.coop-spinner'); if (sp) sp.classList.add('coop-spinner-ok'); }
  }
  _coopFail(el, net, msg) {
    try { net.close(); } catch (e) { /* gone */ }
    this._pendingNet = null; this._coopClearTimers();
    const panel = el.querySelector('.coop-panel');
    panel.innerHTML = `
      <div class="coop-title">Couldn’t connect</div>
      <div class="coop-sub">${msg}</div>
      <button class="btn ghost" data-act="back">← Back</button>`;
    panel.querySelector('[data-act="back"]').addEventListener('click', () => { this._clearCoopOverlay(); this.onQuit && this.onQuit(); });
  }
  _coopClearTimers() {
    clearTimeout(this._coopReassure); clearTimeout(this._coopFailTimer); clearTimeout(this._coopLaunchTimer);
    this._coopReassure = this._coopFailTimer = this._coopLaunchTimer = null;
  }

  // ---------- co-op: downs / revives (host-authoritative) ----------
  _isReviving(r) {
    if (r === this.player) return this.input.isDown('interact');
    if (r._netInput) return r._netInput.isDown('interact');
    return false;
  }

  _updateDownsAndRevives(dt, ctx) {
    let anyUp = false;
    for (const p of this.players) {
      if (!p.dead && !p.downed) { anyUp = true; continue; }
      if (!p.downed) continue;
      p.bleedT -= dt;                                   // bleed out if no one reaches them
      if (p.bleedT <= 0) { p.downed = false; p.dead = true; p.reviveProg = 0; continue; }
      let reviving = false;                             // a standing teammate, in range, holding Interact
      for (const r of this.players) {
        if (r === p || r.dead || r.downed) continue;
        if (r.pos.distanceTo(p.pos) <= COOP.REVIVE_RANGE && this._isReviving(r)) { reviving = true; break; }
      }
      if (reviving) {
        p.reviveProg = Math.min(1, p.reviveProg + dt / COOP.REVIVE_TIME);
        if (p.reviveProg >= 1) {
          p.revive();
          this.audio.sfx('shieldrecharge'); this._netPush('sfx', 'shieldrecharge');
          this.hud.banner('REVIVED', 'Back in the fight!', 1.4); this._netPush('banner', 'REVIVED', 'Back in the fight!', 1.4);
        }
      } else {
        p.reviveProg = Math.max(0, p.reviveProg - dt * 0.5);   // bleed the progress back off
      }
    }
    if (!anyUp && !this._coopOver) this._coopAllDown();
  }

  _coopAllDown() {
    if (this._coopOver) return;
    this._coopOver = true;
    if (this._coopMode === 'campaign') {                            // both fell mid-mission → shared retry
      this._netPush('coopfail');
      if (this.net) this.net.send('snap', serializeSnapshot(this));
      this._showCoopFail(true);
      return;
    }
    const wave = this.survival ? this.survival.wave : 0;
    const score = this.survival ? this.survival.score : 0;
    if (this.survival) this.survival.recordBest();
    this._netPush('coopover', wave, score);
    if (this.net) this.net.send('snap', serializeSnapshot(this));   // flush the event to the guest now
    this._showCoopOver(wave, score, true);
  }

  // Shared co-op game-over — shown on BOTH peers (guest gets it via the 'coopover'
  // event). The session STAYS connected: Retry re-runs together with no re-handshake.
  _showCoopOver(wave, score) {
    this.audio.sfx('lose');
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    if (this._svHudEl) this._svHudEl.style.display = 'none';
    this._clearCoopHud();
    const el = this._showCoopOverlay(`
      <div class="coop-title">You Both Fell</div>
      <div class="coop-sub" style="text-align:center">Wave <b>${wave}</b> · Score <b>${score}</b> — still linked up.</div>
      <button class="btn primary" data-act="retry">↻ Retry Together</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="retry"]').addEventListener('click', () => this._coopRetry(el));
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  }

  // Retry from the shared lobby. Host-authoritative: the host rebuilds (fresh seed,
  // both players respawned) and re-sends 'start'; the guest just asks the host to.
  _coopRetry(el) {
    if (this.coopRole === 'host') {
      if (!this._coopOver) return;                 // only valid from the game-over lobby
      this._clearCoopOverlay();
      this._coopBuildMission();                    // rebuild the current mission → guest rebuilds
    } else {
      if (this.net) this.net.send('retryReq', 1);
      this._coopSetStatus(el, 'Asking the host to restart…');
    }
  }

  // A peer's transport dropped. Tell whoever's left and offer the exit.
  _onPeerLeft() {
    if (!this.coopRole || this._coopLeft) return;
    this._coopLeft = true;
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    if (this._svHudEl) this._svHudEl.style.display = 'none';
    if (this._pvpHud) this._pvpHud.style.display = 'none';
    this._clearCoopHud();
    const el = this._showCoopOverlay(`
      <div class="coop-title">${this._pvp ? 'Rival' : 'Partner'} Disconnected</div>
      <div class="coop-sub" style="text-align:center">${this._pvp ? 'Everyone left the match.' : 'Your co-op partner left the session.'}</div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  }

  // ---------- co-op: down/revive HUD (works for host + guest) ----------
  _ensureCoopHud() {
    if (this._coopHud) return;
    const wrap = document.createElement('div');
    wrap.className = 'coop-hud';
    wrap.innerHTML = '<div class="coop-vignette"></div><div class="coop-downmsg"></div><div class="coop-alert"></div><div class="coop-marker"></div><div class="coop-name"></div><div class="coop-arrow"></div>';
    this.root.appendChild(wrap);
    this._coopHud = wrap;
    this._coopVignette = wrap.querySelector('.coop-vignette');
    this._coopDownMsg = wrap.querySelector('.coop-downmsg');
    this._coopAlert = wrap.querySelector('.coop-alert');
    this._coopMarker = wrap.querySelector('.coop-marker');
    this._coopName = wrap.querySelector('.coop-name');
    this._coopArrow = wrap.querySelector('.coop-arrow');
  }
  _clearCoopHud() {
    if (this._coopHud) { this._coopHud.remove(); this._coopHud = null; this._coopVignette = this._coopDownMsg = this._coopAlert = this._coopMarker = this._coopName = this._coopArrow = null; }
  }

  _updateCoopHud() {
    if (!this.coopRole || this.state !== 'playing') { this._clearCoopHud(); return; }
    // during the vehicle escape both ride the transport (invulnerable, co-located) —
    // the down/revive markers are moot and would just clutter screen-centre.
    if (this.vehicle || this._guestGunner) { this._clearCoopHud(); return; }
    this._ensureCoopHud();
    // resolve my own + my partner's down state, whichever side we're on
    let meDowned = false, meDead = false, meBleed = 0, meRevive = 0;
    let pPos = null, pDowned = false, pRevive = 0, pBleed = 0, pDead = false, pHealthFrac = 1;
    if (this.coopRole === 'host') {
      const me = this.player, partner = this._guestPlayer;
      meDowned = me.downed; meDead = me.dead; meBleed = me.bleedT; meRevive = me.reviveProg;
      if (partner) { pPos = partner.pos; pDowned = partner.downed; pRevive = partner.reviveProg; pBleed = partner.bleedT; pDead = partner.dead; pHealthFrac = partner.health / partner.healthMax; }
    } else {
      const gp = this._guestNetState || {};
      meDowned = !!gp.downed; meDead = !!gp.dead; meBleed = gp.bleedT || 0; meRevive = gp.reviveProg || 0;
      const hs = this._hostState;
      if (hs && this._hostAvatar) { pPos = this._hostAvatar.position; pDowned = hs.st === 1; pRevive = hs.reviveProg || 0; pBleed = hs.bleedT || 0; pDead = hs.st === 2; pHealthFrac = (hs.health || 0) / 45; }
    }
    // MY down state: red vignette + centre message
    this._coopVignette.style.opacity = meDowned ? '1' : '0';
    if (meDowned) {
      this._coopDownMsg.style.display = 'block';
      this._coopDownMsg.innerHTML = meRevive > 0.02
        ? `<div class="cd-big">BEING REVIVED…</div><div class="cd-bar"><i style="width:${Math.round(meRevive * 100)}%"></i></div>`
        : `<div class="cd-big">YOU'RE DOWN</div><div class="cd-sub">Hold on — a teammate can revive you</div><div class="cd-timer">${Math.ceil(meBleed)}s</div>`;
    } else { this._coopDownMsg.style.display = 'none'; }
    // PARTNER: nameplate when up & on-screen; revive marker when downed & on-screen;
    // an edge arrow toward a DOWNED partner who's off-screen; a top alert when downed.
    const W = window.innerWidth, H = window.innerHeight;
    let aAlert = false, aMarker = false, aName = false, aArrow = false;
    if (pPos && !pDead && !meDowned && !meDead) {
      const key = this._ctrlKey('interact', 'USE');
      const dist = this.player.pos.distanceTo(pPos);
      const inRange = dist <= COOP.REVIVE_RANGE;
      const v = new THREE.Vector3(pPos.x, pPos.y + 1.85, pPos.z).project(this.camera);
      const behind = v.z > 1;
      const onScreen = !behind && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95;
      if (onScreen) {
        const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        if (pDowned) {
          aMarker = true;
          this._coopMarker.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
          this._coopMarker.innerHTML = inRange
            ? `<div class="cm-pip rev">＋</div><div class="cm-lbl">${key} · ${Math.round(pRevive * 100)}%</div>`
            : `<div class="cm-pip">▾</div><div class="cm-lbl">${Math.round(dist)}m · ${Math.ceil(pBleed)}s</div>`;
        } else {
          aName = true;
          this._coopName.style.transform = `translate(-50%,-100%) translate(${x}px,${y - 6}px)`;
          this._coopName.innerHTML = `<span class="cn-tag">ALLY</span><span class="cn-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, pHealthFrac)) * 100)}%"></i></span>`;
        }
      } else if (pDowned) {
        aArrow = true;
        let dx = v.x, dy = v.y; if (behind) { dx = -dx; dy = -dy; }
        const ang = Math.atan2(dy, dx);
        const ex = Math.cos(ang), ey = Math.sin(ang);
        const sc = Math.min((W / 2 - 56) / Math.max(1e-3, Math.abs(ex)), (H / 2 - 56) / Math.max(1e-3, Math.abs(ey)));
        const px = W / 2 + ex * sc, py = H / 2 - ey * sc;
        this._coopArrow.style.transform = `translate(-50%,-50%) translate(${px}px,${py}px)`;
        this._coopArrow.innerHTML = `<span class="ca-chev" style="transform:rotate(${-ang}rad)">➤</span><span class="ca-lbl">DOWN · ${Math.ceil(pBleed)}s</span>`;
      }
      if (pDowned) {
        aAlert = true;
        this._coopAlert.textContent = inRange ? `⚠ PARTNER DOWN — hold ${key} to revive` : `⚠ PARTNER DOWN — reach them! ${Math.ceil(pBleed)}s`;
      }
    }
    this._coopAlert.style.display = aAlert ? 'block' : 'none';
    this._coopMarker.style.display = aMarker ? 'block' : 'none';
    this._coopName.style.display = aName ? 'block' : 'none';
    this._coopArrow.style.display = aArrow ? 'block' : 'none';
  }

  // MANUAL host (no relays): produce an offer, paste back the guest's answer.
  async coopHostManual(mode) {
    this._coopMode = mode || 'survival';
    const net = createManual('host'); this._pendingNet = net;
    const offer = await net.manual.createOffer();
    const el = this._showCoopOverlay(`
      <div class="coop-title">Manual Host (no relays)</div>
      <div class="coop-sub">1. Copy this offer and send it to your buddy:</div>
      <textarea class="coop-blob" readonly>${offer}</textarea>
      <button class="btn" data-act="copy">⧉ Copy Offer</button>
      <div class="coop-sub">2. Paste the answer they send back:</div>
      <textarea class="coop-blob" data-field="answer" placeholder="Paste answer code…"></textarea>
      <button class="btn primary" data-act="connect">Connect</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="copy"]').addEventListener('click', () => { try { navigator.clipboard.writeText(offer); } catch (e) {} });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    el.querySelector('[data-act="connect"]').addEventListener('click', async () => {
      const ans = el.querySelector('[data-field="answer"]').value.trim();
      const st = el.querySelector('.coop-status');
      if (!ans) { st.textContent = 'Paste the answer code first.'; return; }
      try { await net.manual.acceptAnswer(ans); st.textContent = 'Linking…'; } catch (e) { st.textContent = 'That answer code looks invalid.'; }
    });
    net.onState((s) => { if (s === 'connected' && this.coopRole !== 'host') { this._coopSetStatus(el, 'Connected! Launching…', true); this._coopLaunchTimer = setTimeout(() => { this._pendingNet = null; this._clearCoopOverlay(); this.startCoopHost(net); }, 700); } });
  }

  // MANUAL join (no relays): paste the host's offer, generate an answer to send back.
  coopJoinManual(mode) {
    this._coopMode = mode || 'survival';
    const net = createManual('guest'); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Manual Join (no relays)</div>
      <div class="coop-sub">1. Paste the offer code from the host:</div>
      <textarea class="coop-blob" data-field="offer" placeholder="Paste offer code…"></textarea>
      <button class="btn primary" data-act="answer">Generate Answer</button>
      <div class="coop-sub coop-hidden" data-row="answer">2. Copy this answer and send it back to the host:</div>
      <textarea class="coop-blob coop-hidden" data-field="answerout" data-row="answer" readonly></textarea>
      <button class="btn coop-hidden" data-act="copy" data-row="answer">⧉ Copy Answer</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    this.joinCoop(net);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    el.querySelector('[data-act="answer"]').addEventListener('click', async () => {
      const offer = el.querySelector('[data-field="offer"]').value.trim();
      const st = el.querySelector('.coop-status');
      if (!offer) { st.textContent = 'Paste the offer code first.'; return; }
      try {
        const answer = await net.manual.acceptOffer(offer);
        el.querySelector('[data-field="answerout"]').value = answer;
        el.querySelectorAll('[data-row="answer"]').forEach((n) => n.classList.remove('coop-hidden'));
        st.textContent = 'Waiting for the host to connect…';
      } catch (e) { st.textContent = 'That offer code looks invalid.'; }
    });
    el.querySelector('[data-act="copy"]').addEventListener('click', () => { try { navigator.clipboard.writeText(el.querySelector('[data-field="answerout"]').value); } catch (e) {} });
  }

  _initGuestSurvivalHud() {
    const el = document.createElement('div');
    el.className = 'survival-hud';
    el.innerHTML = `<div class="sv-wave"></div><div class="sv-score"></div><div class="sv-foe"></div>`;
    this.root.appendChild(el);
    this._svHudEl = el;
  }

  // GUEST update: predict our own movement/aim locally, forward input to the host,
  // and render the rest of the world (enemy/projectile ghosts, host avatar) from
  // the latest snapshot. No AI, no authoritative damage — the host owns all that.
  _updateGuest(dt) {
    this._netClock = (this._netClock || 0) + dt;   // monotonic clock for snapshot interpolation
    if (this.isTouch && this.touch) { const fire = this.touch.fireHeld || this.touch.tapFire; this.touch.tapFire = false; this.input.setVirtual('fire', fire); }
    this.input.beginFrame();
    const ctx = this._ctx();
    // as a turret gunner, Fire/ADS work the turret — never our handheld scope/ADS.
    const gunner = this._guestGunner && this._vehGhost;
    this.settings._adsActive = !gunner && this.input.isDown('ads') && this.player.weapon != null;
    const scoped = !gunner && !!(this.settings._adsActive && this.player.weapon && this.player.weapon.def.scoped);
    if (scoped !== this._scoped) { this._scoped = scoped; this.audio.sfx(scoped ? 'scopein' : 'scopeout'); }

    interpolateGhosts(this, dt);   // update ghost/host-avatar/vehicle positions before we ride them
    if (this._pvp) interpPvp(this, dt);   // every other player's avatar
    // PvP: the host owns our life. While dead we freeze (respawn overlay); on the
    // dead→alive edge we snap to our spawn (the host has already moved us there).
    const pvpDead = !!(this._pvp && this._pvpMe && this._pvpMe.dead);
    if (this._pvp && this._wasPvpDead && !pvpDead && this._mySpawn) { this.player.pos.copy(this._mySpawn); this.player.vel.set(0, 0, 0); this.player.yaw = this._mySpawn.yaw || 0; }
    this._wasPvpDead = pvpDead;
    if (gunner) {
      // turret seat: position comes from the host's synced transform (the vehicle
      // ghost); we just free-look to aim and forward Fire — the host's turret shoots.
      this.player.driving = true;
      this.player._look(this.input, this.settings);
      this.player.pos.copy(this._vehGhost.mesh.position);
      this.player._syncCamera(this.settings, dt);
    } else if (pvpDead) {
      this.player._look(this.input, this.settings);   // spectate-look while dead, no move
      this.player._syncCamera(this.settings, dt);
    } else {
      this.player.driving = false;
      this.player.updateGuest(dt, this.input, this.settings, ctx);
    }
    this._setViewModel(this.player.weapon ? this.player.weapon.key : null);
    if (!gunner) this._guestFireCosmetic(dt);
    this._updateViewModel(dt, scoped);

    this._netInputAccum += dt;
    if (this._netInputAccum >= NET_INPUT_DT && this.net) {
      this._netInputAccum = 0;
      this.net.send('input', serializeInput(this.player, this.input, this.touch, ++this._netSeq));
    }

    this._updateGuestHud(dt, scoped);
    if (this._pvp) this._updatePvpHud(); else this._updateCoopHud();
    if (this.aureole) this.aureole.rotation.z += dt * 0.01;
    this.input.endFrame();
  }

  // Local-only fire feedback for the guest (muzzle flash + sfx). Damage and ammo
  // are the host's; we just make pulling the trigger feel alive. Gated by the
  // host-reported ammo so an empty mag stays quiet.
  _guestFireCosmetic(dt) {
    if (this._guestFireCd > 0) this._guestFireCd -= dt;
    const w = this.player.weapon; if (!w) return;
    const def = w.def;
    const gp = this._guestNetState;
    if (gp && gp.ammo <= 0) return;
    const alt = this.input.isDown('ads') && def.alt;
    const wantFire = def.auto ? this.input.isDown('fire') : this.input.pressed('fire');
    if (wantFire && this._guestFireCd <= 0) {
      this._guestFireCd = 1 / ((alt ? def.alt.fireRate : def.fireRate) || 4);
      this.audio.sfx((alt && def.alt.sfx) ? def.alt.sfx : def.sfx);
      this._muzzle(def);
      this.player.justFired = 0.06;
    }
  }

  _updateGuestHud(dt, scoped) {
    const gp = this._guestNetState;
    let hs;
    if (this._pvp && this._pvpMe) {
      // Deathmatch: our authoritative state (health/ammo/weapon) comes from the host
      // via the all-players snapshot; grenades are cosmetic-local.
      const me = this._pvpMe;
      hs = {
        shield: me.shield, shieldMax: this.player.shieldMax, health: me.health, healthMax: this.player.healthMax,
        weapon: me.weapon, altName: null, stowed: null, reticle: me.reticle,
        ammo: me.ammo, reserve: me.reserve, reloading: me.reloading,
        grenades: this.player.grenades, grenadeType: this.player.grenadeType, cook: null,
        dmgSfx: null, hitFlash: false, lowShield: me.shield <= 0 && me.health < this.player.healthMax * 0.5,
        scoped, scopeZoom: scoped && this.player.weapon ? this.player.weapon.def.adsZoom : 0, driving: false,
      };
    } else if (this._guestGunner && this._vehGhost) {
      // turret gunner: an IRIS readout (unlimited, no reload) in place of the
      // suppressed handheld weapon; the centred crosshair is the turret's aim.
      hs = {
        shield: gp ? gp.shield : this.player.shield, shieldMax: gp ? gp.shieldMax : this.player.shieldMax,
        health: gp ? gp.health : this.player.health, healthMax: gp ? gp.healthMax : this.player.healthMax,
        weapon: 'IRIS TURRET', altName: null, stowed: null, reticle: 'dot',
        ammo: '∞', reserve: '', reloading: false, noReserve: true,
        grenades: gp ? gp.grenades : { frag: 0, goober: 0 }, grenadeType: gp ? gp.grenadeType : 'frag', cook: null,
        dmgSfx: null, hitFlash: false, lowShield: false, scoped: false, scopeZoom: 0, driving: false,
      };
    } else hs = gp ? {
      shield: gp.shield, shieldMax: gp.shieldMax, health: gp.health, healthMax: gp.healthMax,
      weapon: gp.weapon, altName: gp.altName, stowed: null, reticle: gp.reticle,
      ammo: gp.ammo, reserve: gp.reserve, reloading: gp.reloading,
      grenades: gp.grenades, grenadeType: gp.grenadeType, cook: gp.cook,
      dmgSfx: null, hitFlash: false, lowShield: gp.shield <= 0 && gp.health < gp.healthMax * 0.5,
      scoped, scopeZoom: scoped && this.player.weapon ? this.player.weapon.def.adsZoom : 0, driving: false,
    } : this.player.hudState();
    const ghostEnemies = [];
    for (const [, g] of this._ghosts) if (!g.dead) ghostEnemies.push({ pos: g.mesh.position });
    this.hud.update(dt, hs, ghostEnemies, this.player);
    if (this._svHudEl && this._svNetState) {
      const s = this._svNetState;
      this._svHudEl.querySelector('.sv-wave').textContent = 'WAVE ' + (s[0] || '—');
      this._svHudEl.querySelector('.sv-score').textContent = 'SCORE ' + s[1];
      this._svHudEl.querySelector('.sv-foe').textContent = s[2] === 'fighting' ? s[3] + ' left' : s[2] === 'breather' ? 'next wave…' : '';
    }
  }

  // weapon viewmodel kick + sway — shared by solo/host (_updatePlay) and guest
  _updateViewModel(dt, scoped) {
    if (this._viewModel) {
      this._viewModel.visible = !scoped && !this.player.driving && !this._nadeModel && !this._meleeModel;
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
    if (this.coopRole === 'host') {
      // co-op: the host DRIVES, the guest gunner mans IRIS's turret. Seat the guest
      // beside us and make the run a driving/shooting gauntlet (no incoming damage),
      // so a downed passenger can't soft-lock the timed escape (the driver can't revive).
      const guest = this._guestPlayer;
      if (this.player.downed || this.player.dead) this.player.revive();   // start the finale clean
      if (guest) {
        if (guest.downed || guest.dead) guest.revive();
        guest.driving = true; guest._gunner = true; guest.pos.copy(this.vehicle.pos); guest.dmgTakenMult = 0;
      }
      this.player.dmgTakenMult = 0;
      this.hud.setObjective('DRIVE — race the collapse to the Vanguard. Mind the edges.');
      this.hud.banner('DRIVE', 'Floor it — your gunner clears the road. No guardrails, no time.', 2.6);
      this._netPush('mountveh', 'GUNNER — work IRIS’s turret. Aim and hold Fire to clear the road.');
      if (this.net) this.net.send('snap', serializeSnapshot(this));   // get the gunner mounted promptly
    }
  }

  // GUEST: the host just mounted the transport — we're the gunner. Ride the seat
  // (position comes from the host's synced transform), free-look to aim, Fire to
  // shoot the host's turret. A vehicle ghost replaces our buddy avatar.
  _guestEnterGunner(objective) {
    this._guestGunner = true;
    if (!this._vehGhost) {
      const mesh = AssetFactory.vehicle();
      this.scene.add(mesh);
      this._vehGhost = { mesh, buf: [] };
    }
    if (this._hostAvatar) this._hostAvatar.visible = false;   // we ride together; show the truck, not the buddy
    if (this._viewModel) this._viewModel.visible = false;
    this.hud.setObjective(objective || 'GUNNER — aim and Fire to clear the road.');
    this.hud.banner('GUNNER', 'You’re on IRIS’s turret — aim and hold Fire to clear the path.', 2.6);
    this.audio.sfx('objective');
  }
  _clearVehGhost() {
    if (this._vehGhost) { this.scene.remove(this._vehGhost.mesh); this._vehGhost = null; }
    this._guestGunner = false;
  }

  // ---------- PvP: Deathmatch — FFA & 2v2 teams (host-authoritative, multi-peer) ----------
  // Who a shooter may damage: enemies in PvE; opposing players in PvP (never self;
  // never a teammate in 2v2). Used by hitscan, projectiles, splash and aim-assist.
  _combatTargets(shooter) {
    if (!this._pvp) return this.enemies;
    const out = [];
    for (const p of this.players) {
      if (!p || p === shooter || p.dead || p.downed) continue;
      if (this._pvp.teams && shooter && p._team != null && p._team === shooter._team) continue;
      out.push(p);
    }
    return out;
  }

  // Up to four spawns at the arena corners, each facing the centre.
  _pvpSpawns(n) {
    const r = (this.level && this.level.segments[0]) || { cx: 0, cz: 0, w: 30, d: 40 };
    const rx = r.w * 0.32, rz = r.d * 0.32;
    const corners = [[-rx, -rz], [rx, rz], [rx, -rz], [-rx, rz]];
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = corners[i % 4];
      const v = new THREE.Vector3(r.cx + c[0], 1.2, r.cz + c[1]);
      v.yaw = Math.atan2(-c[0], -c[1]);     // look toward centre
      out.push(v);
    }
    return out;
  }

  // HOST lobby → start: wire the one-time net handlers (input is tagged by peerId so
  // each guest's controls reach the right body), then build the first round.
  startPvpHost(net) {
    this.net = net; this.coopRole = 'host';
    this._coopOver = false; this._coopLeft = false;
    this._pvpPeers = (this._lobbyPeers || []).slice();   // peers gathered in the lobby
    net.on('input', (pkt, peerId) => { const g = this._pvpGuests && this._pvpGuests.get(peerId); if (g && g._netInput) g._netInput.feed(pkt); });
    net.on('rematchReq', () => { if (this._pvp && this._pvp.over) this._pvpBuild(); });
    net.onPeerGone((id) => this._onPvpPeerGone(id));
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
    this._pvpBuild();
  }

  // HOST: (re)build the arena under a shared seed, drop every player at a corner, assign
  // teams, and ship each guest a targeted 'start'. _pvp is set AFTER _beginMission (whose
  // teardown clears it), so it can never leak into a later run.
  _pvpBuild() {
    this._coopOver = false; this._coopLeft = false;
    this._setRunMods([]); this._daily = null; this._resume = false;
    this._levelSeed = (Date.now() & 0x7fffffff) || 1;
    this._beginMission(SURVIVAL_MISSION);
    this.level.freeplay = true;
    const teams = this._pvpConfig.mode === 'teams';
    this._pvp = { fragLimit: this._pvpConfig.fragLimit, mode: this._pvpConfig.mode, teams, over: false };
    const peers = this._pvpPeers;
    const sp = this._pvpSpawns(peers.length + 1);
    this._pvpGuests = new Map();
    // host = player id 0
    this._pvpArm(this.player, sp[0], 0, teams ? 0 : 0, 'You');
    this.player._syncCamera(this.settings, 0);
    // one body per connected peer
    peers.forEach((peerId, i) => {
      const pid = i + 1, team = teams ? pid % 2 : pid;
      const g = this.addRemotePlayer(sp[pid], { color: pvpColor(teams, pid, team), id: 'p' + pid, weapons: ['rifle', 'pistol'] });
      g._netInput = new NetInputProxy();
      this._pvpArm(g, sp[pid], pid, team, teams ? `Blue ${Math.ceil(pid / 2)}` : 'P' + (pid + 1));
      this._pvpGuests.set(peerId, g);
      this.net.send('start', { seed: this._levelSeed, mode: this._pvp.mode, fragLimit: this._pvp.fragLimit,
        myId: pid, team, players: peers.length + 1,
        spawn: { x: sp[pid].x, y: sp[pid].y, z: sp[pid].z, yaw: sp[pid].yaw } }, peerId);
    });
    this._ensurePvpHud();
    this.hud.banner(teams ? 'TEAM DEATHMATCH' : this._pvp.mode === 'duel' ? 'DUEL' : 'FREE-FOR-ALL', `First to ${this._pvp.fragLimit} frags${teams ? ' (team total)' : ''}.`, 2.6);
  }

  // Configure a player as a PvP combatant: a fixed spawn, id/team/name, fresh score,
  // and "dies, not downs" rules.
  _pvpArm(p, spawn, pid, team, name) {
    p.pos.copy(spawn); p.yaw = spawn.yaw || 0; p.vel.set(0, 0, 0);
    p.downable = false; p.dead = false; p.downed = false;
    p.health = p.healthMax; p.shield = p.shieldMax; p.regenT = 0;
    p._pid = pid; p._team = team; p._pvpName = name; p._frags = 0; p._spawn = spawn;
    p._respawnT = null; p._pvpDeadHandled = false; p.lastAttacker = null;
    if (p._avatar) p._avatar.visible = true;
  }

  _pvpRespawn(p) {
    p.dead = false; p.downed = false; p.health = p.healthMax; p.shield = p.shieldMax; p.regenT = 0;
    p.pos.copy(p._spawn); p.vel.set(0, 0, 0); p.yaw = p._spawn.yaw || 0; p.lastAttacker = null;
    if (p === this.player) this.player._syncCamera(this.settings, 0);
    if (p._avatar) p._avatar.visible = true;
  }

  _teamFrags(team) { let t = 0; for (const p of this.players) if (p && p._team === team) t += (p._frags || 0); return t; }

  // HOST: deaths → frags → respawns → win. Runs each frame while a match is live.
  _pvpUpdate(dt) {
    if (!this._pvp) return;
    for (const p of this.players) {
      if (p.dead && !p._pvpDeadHandled) {
        p._pvpDeadHandled = true; p._respawnT = 3.0;
        if (p._avatar) p._avatar.visible = false;
        const killer = p.lastAttacker;
        const selfKill = !killer || killer === p || (this._pvp.teams && killer._team === p._team);
        if (!selfKill) killer._frags = (killer._frags || 0) + 1;
        const kName = selfKill ? '☠' : killer._pvpName;
        this.hud.killFeed(`${kName} ▸ ${p._pvpName}`, selfKill ? 0x9aa7b3 : 0xff6a3d);
        this._netPush('frag', kName, p._pvpName);
        if (!selfKill) {
          if (this._pvp.teams) { if (this._teamFrags(killer._team) >= this._pvp.fragLimit) { this._pvpEnd(killer); return; } }
          else if (killer._frags >= this._pvp.fragLimit) { this._pvpEnd(killer); return; }
        }
      }
      if (p.dead && p._respawnT != null) {
        p._respawnT -= dt;
        if (p._respawnT <= 0 && !this._pvp.over) { p._respawnT = null; p._pvpDeadHandled = false; this._pvpRespawn(p); }
      }
    }
  }

  // A peer dropped mid-match — remove its body so the match continues for the rest.
  _onPvpPeerGone(id) {
    if (!this._pvpGuests) return;
    const g = this._pvpGuests.get(id);
    if (!g) return;
    this._pvpGuests.delete(id);
    if (g._avatar) this.scene.remove(g._avatar);
    const i = this.players.indexOf(g); if (i >= 0) this.players.splice(i, 1);
    if (this._pvpPeers) { const pi = this._pvpPeers.indexOf(id); if (pi >= 0) this._pvpPeers.splice(pi, 1); }
    this.hud.killFeed(`${g._pvpName} left`, 0x9aa7b3);
    if (this._pvpGuests.size === 0) this._onPeerLeft();   // last rival gone → end
  }

  _pvpEnd(winner) {
    this._pvp.over = true;
    const meWon = this._pvp.teams ? winner._team === this.player._team : winner === this.player;
    this._netPush('pvpover', winner._pid, winner._pvpName, this._pvp.teams ? 1 : 0, winner._team);
    if (this.net) this.net.send('pvpsnap', serializePvpSnap(this));   // flush the result now
    this._showPvpOver(meWon, winner._pvpName);
  }

  // GUEST: register handlers; the arena is built when the host's 'start' arrives.
  joinPvp(net) {
    this.net = net; this.coopRole = 'guest';
    this._coopOver = false; this._coopLeft = false;
    net.on('start', (d) => this._beginPvpGuest(d));
    net.on('pvpsnap', (snap) => { applyPvpSnap(this, snap); });
    net.onState((s) => { if (s === 'closed') this._onPeerLeft(); });
  }

  _beginPvpGuest(d) {
    this._netClock = 0;
    this._levelSeed = d.seed;
    this._setRunMods([]); this._daily = null; this._resume = false; this._runPerks = [];
    this._beginMission(SURVIVAL_MISSION);      // teardown clears any prior _pvp
    this.level.freeplay = true;
    this._pvp = { fragLimit: d.fragLimit || 15, mode: d.mode, teams: d.mode === 'teams', over: false };
    this._myId = d.myId; this._myTeam = d.team;
    this.player.downable = false; this.player._pid = d.myId; this.player._team = d.team;
    if (d.spawn) { this._mySpawn = new THREE.Vector3(d.spawn.x, d.spawn.y, d.spawn.z); this._mySpawn.yaw = d.spawn.yaw || Math.PI;
      this.player.pos.copy(this._mySpawn); this.player.yaw = this._mySpawn.yaw; this.player._syncCamera(this.settings, 0); }
    this._pvpAvatars = new Map();              // every OTHER player, drawn from snapshots
    this._pvpMe = null; this._pvpBoard = null; this._wasPvpDead = false;
    this._ensurePvpHud();
    this._clearCoopOverlay(); this._clearResult();
    this.hud.banner(d.mode === 'teams' ? 'TEAM DEATHMATCH' : d.mode === 'duel' ? 'DUEL' : 'FREE-FOR-ALL', `First to ${this._pvp.fragLimit} frags.`, 2.6);
  }

  // ---------- PvP: lobby ----------
  // HOST: open a room, gather peers, let the host start when ready. opts = { mode, fragLimit }.
  pvpHost(opts) {
    const code = makeRoomCode();
    const net = hostTrystero(code); this._pendingNet = net;
    const mode = (opts && opts.mode) || 'ffa';
    this._pvpConfig = { fragLimit: (opts && opts.fragLimit) || 15, mode };
    this._lobbyPeers = [];
    const duel = mode === 'duel';
    const cap = duel ? 2 : 4;                          // duel = exactly two players
    const modeName = duel ? '1v1 Duel' : mode === 'teams' ? '2v2 Teams' : 'Free-for-All';
    const launch = () => { this._pendingNet = null; this._clearCoopOverlay(); this.startPvpHost(net); };
    const el = this._showCoopOverlay(`
      <div class="coop-title">Hosting ${modeName}</div>
      <div class="coop-sub">Share this code — ${duel ? 'your rival opens' : 'rivals open'} <b>Deathmatch</b> and pick${duel ? 's' : ''} <b>Join</b>:</div>
      <div class="coop-code">${code}</div>
      <button class="btn" data-act="copy">⧉ Copy Code</button>
      <div class="coop-sub" style="margin-top:8px">First to <b>${this._pvpConfig.fragLimit}</b> frags · ${duel ? '2 players' : 'up to <b>' + cap + '</b> players'}.</div>
      <div class="pvp-roster" data-roster>You (host)</div>
      ${duel ? '<div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Waiting for your rival to join…</span></div>' : '<button class="btn primary" data-act="start" disabled>▶ Start Match</button>'}
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    const copyBtn = el.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy Code'; }, 1200); } catch (e) {} });
    const startBtn = el.querySelector('[data-act="start"]');
    const roster = el.querySelector('[data-roster]');
    const refresh = () => { roster.innerHTML = 'You (host)' + this._lobbyPeers.map((_, i) => `<br>Player ${i + 2} — joined`).join(''); if (startBtn) startBtn.disabled = this._lobbyPeers.length < 1; };
    net.onPeer((id) => {
      if (this._lobbyPeers.length < cap - 1 && !this._lobbyPeers.includes(id)) { this._lobbyPeers.push(id); this.audio.sfx('ui'); refresh(); }
      // a 1v1 needs no "Start" — launch as soon as the single rival connects
      if (duel && this._lobbyPeers.length >= 1) { this._coopSetStatus(el, 'Rival connected! Launching…', true); this._coopLaunchTimer = setTimeout(launch, 700); }
    });
    net.onPeerGone((id) => { const i = this._lobbyPeers.indexOf(id); if (i >= 0) { this._lobbyPeers.splice(i, 1); refresh(); } });
    if (startBtn) startBtn.addEventListener('click', () => { if (!this._lobbyPeers.length) return; launch(); });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
  }
  pvpJoin(code) {
    const net = joinTrystero(code); this._pendingNet = net;
    const el = this._showCoopOverlay(`
      <div class="coop-title">Joining ${code}</div>
      <div class="coop-wait"><span class="coop-spinner"></span><span class="coop-status">Reaching the host…</span></div>
      <div class="coop-dim">Peer-to-peer can take a few seconds to link up.</div>
      <button class="btn ghost" data-act="cancel">Cancel</button>`);
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => this._coopCancel(net));
    this.joinPvp(net);
    this._coopReassure = setTimeout(() => this._coopSetStatus(el, 'Still linking… hang tight (relays can be slow).'), 5000);
    this._coopFailTimer = setTimeout(() => { if (!this.level) this._coopFail(el, net, 'Couldn’t reach the host. Double-check the code and that they’re still hosting.'); }, 25000);
    net.onState((s) => { if (s === 'connected') this._coopSetStatus(el, 'Connected! Waiting for the host to start…', true); });
  }

  // ---------- PvP: scoreboard HUD ----------
  _ensurePvpHud() {
    if (this._pvpHud) return;
    const el = document.createElement('div');
    el.className = 'pvp-hud';
    el.innerHTML = '<div class="pvp-board"></div><div class="pvp-respawn"></div>';
    this.root.appendChild(el);
    this._pvpHud = el;
  }
  _clearPvpHud() { if (this._pvpHud) { this._pvpHud.remove(); this._pvpHud = null; } }

  // Build a normalized scoreboard ({rows, respawn}) from whichever side we're on.
  _pvpScore() {
    if (this.coopRole === 'host') {
      const rows = this.players.filter((p) => p).map((p) => ({ name: p._pvpName, team: p._team, frags: p._frags || 0, me: p === this.player }));
      const respawn = this.player._respawnT != null ? Math.ceil(this.player._respawnT) : 0;
      return { rows, respawn };
    }
    const rows = (this._pvpBoard || []).map((b) => ({ name: b.name, team: b.team, frags: b.frags, me: b.pid === this._myId }));
    const respawn = this._pvpMe && this._pvpMe.respawnT ? this._pvpMe.respawnT : 0;
    return { rows, respawn };
  }

  _updatePvpHud() {
    if (!this._pvp || this.state !== 'playing') { if (this._pvpHud) this._pvpHud.style.display = 'none'; return; }
    this._ensurePvpHud(); this._pvpHud.style.display = '';
    const { rows, respawn } = this._pvpScore();
    let html = '';
    if (this._pvp.teams) {
      const t0 = rows.filter((r) => r.team % 2 === 0).reduce((s, r) => s + r.frags, 0);
      const t1 = rows.filter((r) => r.team % 2 === 1).reduce((s, r) => s + r.frags, 0);
      const mine = this._myTeamParity();
      html = `<div class="pvp-teams"><span class="pt a ${mine === 0 ? 'mine' : ''}">BLUE ${t0}</span><span class="pvp-sep">—</span><span class="pt b ${mine === 1 ? 'mine' : ''}">RED ${t1}</span></div><div class="pvp-limit">first to ${this._pvp.fragLimit}</div>`;
    } else {
      const sorted = rows.slice().sort((a, b) => b.frags - a.frags);
      html = '<div class="pvp-list">' + sorted.map((r) => `<div class="pvp-row ${r.me ? 'mine' : ''}"><span class="pr-n">${r.name}</span><span class="pr-f">${r.frags}</span></div>`).join('') + `</div><div class="pvp-limit">first to ${this._pvp.fragLimit}</div>`;
    }
    this._pvpHud.querySelector('.pvp-board').innerHTML = html;
    this._pvpHud.querySelector('.pvp-respawn').textContent = respawn > 0 ? 'RESPAWNING IN ' + respawn : '';
  }
  _myTeamParity() { const t = this.coopRole === 'host' ? this.player._team : this._myTeam; return (t || 0) % 2; }

  _showPvpOver(meWon, winnerName) {
    this.audio.sfx(meWon ? 'win' : 'lose');
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result'; this.hud.show(false);
    if (this._pvpHud) this._pvpHud.style.display = 'none';
    const host = this.coopRole === 'host';
    const { rows } = this._pvpScore();
    const board = rows.slice().sort((a, b) => b.frags - a.frags)
      .map((r) => `<div class="pvp-row ${r.me ? 'mine' : ''}"><span class="pr-n">${r.name}</span><span class="pr-f">${r.frags}</span></div>`).join('');
    const el = this._showCoopOverlay(`
      <div class="coop-title">${meWon ? 'Victory' : 'Defeat'}</div>
      <div class="coop-sub" style="text-align:center">${winnerName} ${this._pvp && this._pvp.teams ? 'team takes' : 'takes'} it</div>
      <div class="pvp-list final">${board}</div>
      ${host ? '<button class="btn primary" data-act="rematch">↻ Rematch</button>' : '<div class="coop-status">Waiting for host to rematch…</div>'}
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    const rm = el.querySelector('[data-act="rematch"]');
    if (rm) rm.addEventListener('click', () => { this._clearCoopOverlay(); this._pvpBuild(); });
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
  }
  // GUEST entry for the broadcast end-of-match event from the host.
  _guestPvpOver(winnerPid, winnerName, teams, winnerTeam) {
    if (this.state === 'result') return;
    if (this._pvp) this._pvp.over = true;
    const won = teams ? (winnerTeam % 2) === this._myTeamParity() : winnerPid === this._myId;
    this._showPvpOver(won, winnerName);
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
    const m = CAMPAIGN[this.missionIndex];
    const isFinaleDone = this.missionIndex >= CAMPAIGN.length - 1;
    // co-op host: don't touch solo save progress; tell the guest, then show the
    // shared mission-complete screen (each side picks its own upgrade).
    if (this.coopRole === 'host') {
      this._coopOver = true;
      this._netPush('mcomplete', isFinaleDone ? 1 : 0);
      if (this.net) this.net.send('snap', serializeSnapshot(this));   // flush so the guest gets it now
      this.hud.banner('MISSION COMPLETE', m.outro, 3);
      setTimeout(() => { if (this.coopRole === 'host') this._showCoopResult(isFinaleDone); }, 2600);
      return;
    }
    // Daily Mission: a one-shot scored run (completion + kills + speed) — its own
    // result screen, no campaign save/perks/advance.
    if (this._daily) {
      const secs = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._dailyStart) / 1000;
      const score = 5000 + this._dailyKills * 10 + Math.max(0, Math.round(1800 - secs * 6));
      this._recordDaily(score);
      this.hud.banner('MISSION COMPLETE', m.outro, 3);
      setTimeout(() => this._showDailyResult(true), 2600);
      return;
    }
    markCompleted(this.missionIndex);
    clearCheckpoint(this.missionIndex);
    this.hud.banner('MISSION COMPLETE', m.outro, 3);
    setTimeout(() => this._showResult(true, isFinaleDone), 2600);
  }
  _missionFailed(reason) {
    if (this.state === 'result') return;
    // co-op host: an objective/escape failure ends the run for both — shared retry.
    if (this.coopRole === 'host') {
      this._coopOver = true;
      this._setPlayInput(false); this.input.exitLock();
      this.state = 'result'; this.hud.clearTransients();
      this._clearNadeModel(); this._clearMeleeModel();
      if (this._viewModel) this._viewModel.visible = !this.player.driving;
      this.audio.sfx('lose');
      this._netPush('coopfail');
      if (this.net) this.net.send('snap', serializeSnapshot(this));
      this.hud.banner('MISSION FAILED', reason || 'You fell on the Aureole.', 2.5);
      setTimeout(() => { if (this.coopRole === 'host') this._showCoopFail(true); }, 2200);
      return;
    }
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.hud.clearTransients();
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = !this.player.driving;
    this.audio.sfx('lose');
    // Daily Mission failure still scores kills (partial credit), then its own screen
    if (this._daily) {
      this._recordDaily(this._dailyKills * 10);
      this.hud.banner('DOWN', reason || 'You fell on the Aureole.', 2.5);
      setTimeout(() => this._showDailyResult(false), 2200);
      return;
    }
    this.hud.banner('DOWN', reason || 'You fell on the Aureole.', 2.5);
    setTimeout(() => this._showResult(false, false), 2200);
  }

  // Daily run result (mission win/lose, or routed here from Survival's game-over).
  // Shows the score, today's best, and a copyable share code; Retry replays the
  // exact same daily; otherwise back to the menu.
  _showDailyResult(win) {
    this.hud.show(false);
    this._clearResult();
    const r = this._lastDaily || { score: 0, best: 0, code: '' };
    const isMission = this._daily && this._daily.mode === 'mission';
    const beat = r.best <= r.score;
    this.result = document.createElement('div');
    this.result.className = 'interactive';
    this.result.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title" style="font-size:48px">${isMission ? (win ? 'Daily Mission Cleared' : 'Daily Mission — Down') : 'Daily Survival'}</div>
          <div class="game-tag">Score <b>${r.score}</b> · Today's best <b>${r.best}</b>${beat && r.score > 0 ? ' &nbsp;★ new best!' : ''}</div>
        </div>
        <div class="daily-share">
          <div class="daily-share-label">Share your result — paste it to a friend to challenge today's seed:</div>
          <div class="daily-code-row"><code class="daily-code">${r.code}</code><button class="btn" data-act="copy">⧉ Copy</button></div>
        </div>
        <div class="menu-list">
          <button class="btn primary" data-act="retry">↻ Replay Today's Daily</button>
          <button class="btn" data-act="menu">⏏ Main Menu</button>
        </div>
      </div>`;
    this.root.appendChild(this.result);
    const copyBtn = this.result.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(r.code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1200); } catch (e) {} });
    this.result.querySelector('[data-act="retry"]').addEventListener('click', () => { this.audio.sfx('ui'); this._clearResult(); this._replayDaily(); });
    this.result.querySelector('[data-act="menu"]').addEventListener('click', () => { this.audio.sfx('ui'); this._clearResult(); this.quitToMenu(); });
  }

  // ---------- co-op: campaign mission flow (host-authoritative) ----------
  // GUEST: the host finished the mission. Freeze, then show our own complete screen.
  _guestMissionComplete(finaleDone) {
    if (this.state === 'result' || this._coopLeft) return;
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.audio.sfx('win');
    this.hud.banner('MISSION COMPLETE', CAMPAIGN[this.missionIndex] ? CAMPAIGN[this.missionIndex].outro : '', 3);
    setTimeout(() => { if (this.coopRole === 'guest' && !this._coopLeft && this.state === 'result') this._showCoopResult(!!finaleDone); }, 1600);
  }

  // Shared mission-complete screen, shown on BOTH peers. Each side draws and picks
  // its own upgrade; only the HOST gets the "Next Mission" button (host-only continue).
  // The guest forwards its pick and waits — the host's next 'start' rebuilds its world.
  _showCoopResult(finaleDone) {
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    this._clearCoopHud();
    this._hostPendingPerk = null;
    const host = this.coopRole === 'host';
    const next = this.missionIndex + 1 < CAMPAIGN.length;
    const m = CAMPAIGN[this.missionIndex];
    const owned = host ? this._runPerks : this._guestRunPerks;
    const choices = (!finaleDone && next) ? PERK_IDS.filter((id) => !owned.includes(id)).sort(() => Math.random() - 0.5).slice(0, 3) : [];
    const perkSection = choices.length
      ? `<div class="perk-pick"><div class="perk-pick-head">◆ Choose your upgrade</div><div class="perk-cards">${
        choices.map((id) => `<button class="perk-card" data-perk="${id}"><b>${PERKS[id].name}</b><span>${PERKS[id].desc}</span></button>`).join('')
      }</div></div>` : '';
    const buttons = finaleDone
      ? '<button class="btn primary" data-act="leave">★ Finish</button>'
      : (host
        ? '<button class="btn primary" data-act="continue">▶ Next Mission</button><button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>'
        : '<button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>');
    const el = this._showCoopOverlay(`
      <div class="coop-title">${finaleDone ? 'The Halo Goes Dark' : 'Mission Complete'}</div>
      <div class="coop-sub" style="text-align:center">${finaleDone ? 'Sgt. Orion and his partner ride the wreckage out. The Aureole is silent.' : (m ? m.outro : '')}</div>
      ${perkSection}
      <div class="coop-status"></div>
      <div class="menu-list">${buttons}</div>`);
    el.querySelectorAll('[data-perk]').forEach((b) => b.addEventListener('click', () => {
      this.audio.sfx('objective');
      el.querySelectorAll('[data-perk]').forEach((x) => x.classList.remove('chosen'));
      b.classList.add('chosen');
      this._coopPickPerk(b.dataset.perk);
    }));
    const cont = el.querySelector('[data-act="continue"]');
    if (cont) cont.addEventListener('click', () => this._coopAdvance());
    const leave = el.querySelector('[data-act="leave"]');
    if (leave) leave.addEventListener('click', () => this.quitToMenu());
    if (!host && !finaleDone) this._coopSetStatus(el, 'Host leads — pick your upgrade; you’ll deploy when they continue.');
  }

  // Record an upgrade pick. Host stashes it locally (applied on advance); guest
  // forwards it so the host can apply it to the simulated guest on the next build.
  _coopPickPerk(id) {
    if (this.coopRole === 'host') { this._hostPendingPerk = id; }
    else {
      if (this.net) this.net.send('guestPerk', id);
      const st = this._coopOverlayEl && this._coopOverlayEl.querySelector('.coop-status');
      if (st) st.textContent = 'Upgrade locked in — waiting for the host to continue…';
    }
  }

  // HOST only: commit both players' picks and build the next mission (host-only continue).
  _coopAdvance() {
    if (this.coopRole !== 'host') return;
    if (this._hostPendingPerk && !this._runPerks.includes(this._hostPendingPerk)) this._runPerks.push(this._hostPendingPerk);
    if (this._pendingGuestPerk && !this._guestRunPerks.includes(this._pendingGuestPerk)) this._guestRunPerks.push(this._pendingGuestPerk);
    this._hostPendingPerk = null; this._pendingGuestPerk = null;
    this._clearCoopOverlay();
    this.missionIndex = Math.min(this.missionIndex + 1, CAMPAIGN.length - 1);
    this._coopBuildMission();
  }

  // Shared mission-failed screen (both fell, or an objective/escape failed). Retry
  // rebuilds the SAME mission for both; the guest just asks the host to.
  _showCoopFail(isHost) {
    this._setPlayInput(false); this.input.exitLock();
    this.state = 'result';
    this.hud.show(false);
    if (this.survival && this.survival.hudEl) this.survival.hudEl.classList.add('hidden');
    this._clearCoopHud();
    const m = CAMPAIGN[this.missionIndex];
    const el = this._showCoopOverlay(`
      <div class="coop-title">You Both Fell</div>
      <div class="coop-sub" style="text-align:center">${m ? m.name : 'The Aureole'} — still linked up.</div>
      <button class="btn primary" data-act="retry">↻ Retry Mission</button>
      <div class="coop-status"></div>
      <button class="btn ghost" data-act="leave">⏏ Leave to Menu</button>`);
    el.querySelector('[data-act="retry"]').addEventListener('click', () => this._coopRetry(el));
    el.querySelector('[data-act="leave"]').addEventListener('click', () => this.quitToMenu());
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
  // A ground danger-ring that brightens as a boss attack winds up, so the player
  // can read and dodge it. Always shown (it's gameplay-critical, not just flair).
  _spawnTelegraph(p, radius, duration, color) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.1, radius - 0.7), radius, 36),
      new THREE.MeshBasicMaterial({ color: color || 0xff5a5a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.06, p.z);
    this.scene.add(ring);
    this.fx.push({ mesh: ring, life: duration, maxLife: duration, kind: 'telegraph' });
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
    if (this.input._gpActive && !this._gpWasActive && this.state === 'playing') this.hud.banner('CONTROLLER READY', 'Full layout in Settings ▸ Controls', 2.2);
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

    if (this.state === 'playing') {
      if (this.coopRole === 'guest') this._updateGuest(dt);   // thin client: predict + render from snapshots
      else this._updatePlay(dt * scale);                      // solo or co-op host: full sim
    }
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
      // co-op: host drives, the guest's networked input guns the turret. The guest
      // rides along, and the host's player.yaw tracks the heading so the guest's
      // vehicle ghost (built from the synced host transform) faces the right way.
      const gun = (this.coopRole === 'host' && this._guestPlayer) ? this._guestPlayer._netInput : null;
      this.vehicle.update(dt, this.input, ctx, gun);   // drag-look (solo) or remote gunner (co-op)
      this.player.pos.copy(this.vehicle.pos);
      this.player.yaw = this.vehicle.heading;
      if (gun && this._guestPlayer) this._guestPlayer.pos.copy(this.vehicle.pos);
    } else if (this.isTouch) {
      this._touchAssist(dt);                       // soft aim magnetism off the centred reticle
    }
    // advance any co-op/dummy players sharing the world
    for (const rp of this.players) { if (rp !== this.player) this._updateRemotePlayer(rp, dt, ctx); }
    if (this.coopRole === 'host' && this._pvp) this._pvpUpdate(dt);              // deaths/frags/respawns
    else if (this.coopRole === 'host') this._updateDownsAndRevives(dt, ctx);
    // touch QoL: auto-reload a dry magazine
    if (this.isTouch && this.player.weapon && this.player.weapon.needsReload() && this.player.weapon.reloading <= 0) {
      if (this.player.weapon.startReload()) this.audio.sfx('reload');
    }
    this._setViewModel(this.player.weapon ? this.player.weapon.key : null);
    this._updateNadeModel(dt);
    this._updateMeleeModel(dt);

    this._updateViewModel(dt, scoped);

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
    // solo driver-gunner sees the free turret reticle; the co-op host only drives (the guest aims), so hide it
    this.hud.setTurret(this.vehicle && this.coopRole !== 'host' ? { x: this.vehicle.aim.x, y: this.vehicle.aim.y, locked: !!this.vehicle.lockedTarget } : null);
    if (this.coopRole && !this._pvp) this._updateCoopHud();
    if (this._pvp) this._updatePvpHud();

    // player death (Survival runs its own game-over; campaign rooms use onFail). In
    // co-op a single death just downs/kills that player — the shared all-down flow
    // (_coopAllDown) ends the run, so don't fail the mission on one player's death.
    if (this.player.dead && this.state === 'playing' && !this.survival && !this.coopRole) ctx.onFail('Sgt. Orion is down. The eulogy will have to wait.');

    // co-op host: ship the world to the guest at NET_SNAP_HZ
    if (this.coopRole === 'host' && this.net) {
      this._netSnapAccum += dt;
      if (this._netSnapAccum >= NET_SNAP_DT) { this._netSnapAccum = 0; this.net.send(this._pvp ? 'pvpsnap' : 'snap', this._pvp ? serializePvpSnap(this) : serializeSnapshot(this)); }
    }

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
      if (f.kind === 'telegraph') { if (f.mesh.material) f.mesh.material.opacity = 0.2 + 0.6 * (1 - t); } // brighten toward the hit
      if (f.kind === 'goo') {
        f.vel.y -= 18 * dt;
        f.mesh.position.addScaledVector(f.vel, dt);
        if (f.mesh.position.y < 0.08) { f.mesh.position.y = 0.08; f.vel.set(0, 0, 0); }
        if (f.mesh.material) f.mesh.material.opacity = Math.min(0.9, t * 1.4);
      }
      if (f.life <= 0) {
        if (f.parent) f.parent.remove(f.mesh); else this.scene.remove(f.mesh);
        if (f.light) this.scene.remove(f.light);
        // free the GPU resources — every fx kind makes its own geometry+material
        if (f.mesh.geometry) f.mesh.geometry.dispose();
        if (f.mesh.material) f.mesh.material.dispose();
        this.fx.splice(i, 1);
      }
    }
    this._updateDamageNumbers(dt);
  }

  // ---- combat juice ----------------------------------------------------------
  _onEnemyKilled(e) {
    this.hud.killFeed(e.meta.name, e.meta.scoreColor);
    if (this._daily && this._daily.mode === 'mission') this._dailyKills++;   // mission-of-the-day scoring
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
