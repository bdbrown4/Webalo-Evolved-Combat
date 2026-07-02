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
import { getDifficulty } from './Difficulty.js';
import { codeLabel } from './Settings.js';
import { GAMEPAD_BUTTONS } from './Input.js';
import { HUD } from '../ui/HUD.js';
import { TouchControls } from '../ui/TouchControls.js';
import { Tutorial, TUTORIAL_MISSION } from '../ui/Tutorial.js';
import { Survival, SURVIVAL_MISSION } from '../ui/Survival.js';
import { CAMPAIGN, loadCheckpoint, saveCheckpoint, clearCheckpoint, loadProgress } from '../missions/campaign.js';
import { serializeSnapshot, clearGhosts, withSeededRandom, NET_SNAP_DT, serializePvpSnap, clearPvpAvatars } from '../net/CoopSync.js';
import { RemotePlayersMixin } from '../game/RemotePlayers.js';
import { CoopSessionMixin } from '../game/CoopSession.js';
import { PvpSessionMixin } from '../game/PvpSession.js';
import { ScreensMixin } from '../game/Screens.js';
import { FxMixin } from '../game/Fx.js';
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
      ? new TouchControls(root, this.input, { onPause: () => { if (this.state === 'playing') this.togglePause(); } }, settings)
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
    if (this._pvpPads) { for (const pad of this._pvpPads) this.scene.remove(pad.mesh); this._pvpPads = null; }
    this._pvp = null; this._pvpNetState = null; this._clearPvpHud();
    clearPvpAvatars(this); this._pvpMe = null; this._pvpBoard = null; this._pvpGuests = null; this._myId = null;
    this._clearCoopHud();
    if (this._hostAvatar) { this.scene.remove(this._hostAvatar); this._hostAvatar = null; }
    if (this._svHudEl) { this._svHudEl.remove(); this._svHudEl = null; }
    this._guestNetState = null; this._svNetState = null; this._guestPlayer = null; this._netEvents.length = 0;
    this._lastGuestVitals = null;   // fresh world = fresh vitals baseline (a rebuild is not "damage")
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
        // co-op campaign: hold room-clear/advance while a squadmate is down (revive first).
        squadHeld: () => this._coopSquadHeld(),
        // melee attack tokens: at most 3 swarmers press the attack on one player per
        // frame — the rest circle at reach (Enemy._melee). Counters reset per frame.
        meleeToken: (target) => { if (!target) return true; const n = target._meleeSlots || 0; if (n >= 3) return false; target._meleeSlots = n + 1; return true; },
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

  // Untaken pickups for the motion tracker (small gold squares on the dial).
  _trackerExtras() {
    if (!this.level || !this.level.pickups) return null;
    const out = this._trackerScratch || (this._trackerScratch = { pickups: [] });
    out.pickups.length = 0;
    for (const p of this.level.pickups) if (!p.taken) out.pickups.push({ x: p.pos.x, z: p.pos.z });
    return out;
  }

  // Soft aim-assist for touch on foot. The reticle stays centred and the player
  // drags to look; here we find the nearest enemy inside a screen-centre cone and
  // pull the view GENTLY toward it — stronger while firing, fading to nothing at
  // the cone's edge — so shots land without pixel-perfect thumbs. It's a nudge,
  // never a lock: the player's own drag always overrides it. Works in world
  // angles (not mouseDX) so its feel is independent of the sensitivity slider.
  _aimAssistOn() {
    const mode = (this.settings.data.gameplay && this.settings.data.gameplay.aimAssist) || 'auto';
    if (mode === 'off') return 0;
    const padActive = this.input.lastSource === 'pad';
    if (mode === 'auto') return (this.isTouch || padActive) ? 1 : 0;   // thumbs get help, mouse doesn't
    return (this.isTouch || padActive) ? (mode === 'high' ? 1.45 : 0.7) : 0;
  }

  _touchAssist(dt, strength = 1) {
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
    const k = Math.min(0.5, dt * (firing ? 8 : 3) * fade * strength);
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
    for (const pl of this.players) if (pl) pl._meleeSlots = 0;   // melee attack tokens (per frame)

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
    } else {
      const assist = this._aimAssistOn();          // touch + controller magnetism (Settings ▸ Gameplay)
      if (assist > 0) this._touchAssist(dt, assist);
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
    if (hs.dmgSfx) {
      this.audio.sfx(hs.dmgSfx);
      if (this.settings.data.gameplay && this.settings.data.gameplay.haptics) {
        this.input.rumble(hs.dmgSfx === 'shieldbreak' ? 0.9 : 0.5, 130);
        if (this.isTouch && navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
      }
    }

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

    // HUD (tracker blips: untaken pickups, drawn shape-coded on the dial)
    hs.tracker = this._trackerExtras();
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

}

// The Game's method surface is split by domain — multiplayer plumbing, co-op,
// deathmatch, screens, and combat presentation each live in src/game/*. State
// stays on the Game instance; these modules contribute behavior.
Object.assign(Game.prototype, RemotePlayersMixin, CoopSessionMixin, PvpSessionMixin, ScreensMixin, FxMixin);
