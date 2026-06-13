// Menus.js — all front-end screens: main menu, mission select, tabbed settings
// (controls with live rebinding, audio, video), and the pause overlay. Pure DOM,
// driven by callbacks the Game wires in. Reads/writes Settings directly.

import { ACTIONS, codeLabel } from '../core/Settings.js';
import { CAMPAIGN, loadProgress } from '../missions/campaign.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../core/Difficulty.js';

export class Menus {
  constructor(root, settings, input, audio, handlers) {
    this.root = root;
    this.settings = settings;
    this.input = input;
    this.audio = audio;
    this.h = handlers; // { onStart(index), onResume, onRestart, onQuit }
    this.el = document.createElement('div');
    this.el.className = 'interactive';
    root.appendChild(this.el);
    this.screen = null;
  }

  _click() { this.audio.ensure(); this.audio.sfx('ui'); }

  clear() { this.el.innerHTML = ''; this.screen = null; }
  hide() { this.clear(); }

  // ---------------- Main menu ----------------
  showMain() {
    const p = loadProgress();
    const hasProgress = p.completed.length > 0 || p.unlocked > 0;
    this.clear();
    this.screen = 'main';
    this.el.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title">Webalo</div>
          <div class="game-sub">Evolved Combat</div>
          <div class="game-tag">An original open-source FPS · Sgt. Vance Orion vs. the Wobble Coalition</div>
        </div>
        <div class="menu-list">
          <button class="btn primary" data-act="new">▶ New Campaign</button>
          <button class="btn" data-act="continue" ${hasProgress ? '' : 'disabled'}>↻ Continue${hasProgress ? ' — Mission ' + (p.unlocked + 1) : ''}</button>
          <button class="btn" data-act="select">☰ Mission Select</button>
          <button class="btn" data-act="settings">⚙ Settings</button>
          <button class="btn ghost" data-act="credits">ℹ Credits</button>
        </div>
        <div class="menu-footer">
          Open source under MIT · all assets procedural, all audio synthesized<br/>
          <span class="kbd">WASD</span> move · <span class="kbd">Mouse</span> look · <span class="kbd">L-Click</span> fire · <span class="kbd">Esc</span> pause
        </div>
      </div>`;
    this.el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      this._click();
      const a = b.dataset.act;
      if (a === 'new') this.showIntro(() => this.h.onStart(0));
      else if (a === 'continue') this.h.onStart(loadProgress().unlocked);
      else if (a === 'select') this.showMissionSelect();
      else if (a === 'settings') this.showSettings('controls', () => this.showMain());
      else if (a === 'credits') this.showCredits();
    }));
  }

  // ---------------- Opening crawl ----------------
  // A Star Wars-style perspective crawl that plays before a new campaign.
  // Skippable at any time (click Skip, or press Esc / Space / Enter).
  showIntro(onDone) {
    this.clear();
    this.screen = 'intro';
    this.audio.ensure();
    this.audio.setTrack('ambient');

    let done = false;
    const finish = () => {
      if (done) return; done = true;
      window.removeEventListener('keydown', onKey, true);
      this.clear();
      onDone && onDone();
    };
    const onKey = (e) => {
      if (['Escape', 'Space', 'Enter'].includes(e.code)) { e.preventDefault(); finish(); }
    };

    this.el.innerHTML = `
      <div class="crawl-scene interactive">
        <div class="crawl-prelude">A frontier gone quiet. A distress call that should never have been answered.</div>
        <div class="crawl-viewport">
          <div class="crawl-text">
            <div class="crawl-logo">WEBALO</div>
            <div class="crawl-ep">Evolved Combat</div>
            <p>When the lost <b>Vanguard fleet</b> vanished chasing a distress call from the edge of charted space, command wrote them off. The signal kept pulsing.</p>
            <p>Its source was the <b>AUREOLE</b> — a ringworld older than memory, encircled by the <b>WOBBLE COALITION</b>: a swarm of googly-eyed zealots who tend its ancient machinery and worship the ring as a friend. They have no idea what it was built to cage.</p>
            <p>One dropship answered the call. Only Sergeant <b>VANCE ORION</b> walked away from the crash — a lone marine, a cracked AI named <b>IRIS</b>, and a structure the size of a nightmare charging toward something terrible.</p>
            <p>The Coalition thinks he is trespassing. He intends to prove them right.</p>
          </div>
        </div>
        <button class="btn ghost crawl-skip" data-act="skip">Skip ▸</button>
      </div>`;

    const text = this.el.querySelector('.crawl-text');
    text.addEventListener('animationend', finish);
    this.el.querySelector('[data-act="skip"]').addEventListener('click', () => { this._click(); finish(); });
    window.addEventListener('keydown', onKey, true);
  }

  showCredits() {
    this.clear();
    this.el.innerHTML = `
      <div class="screen">
        <div class="panel" style="max-width:560px">
          <div class="panel-head"><h2>Credits</h2></div>
          <div class="panel-body" style="line-height:1.8">
            <p><b>Webalo: Evolved Combat</b> — an original, open-source homage to the early-2000s sci-fi shooter.</p>
            <p>Built with Three.js. Every mesh is generated in code; every sound is synthesized at runtime. No third-party game assets are used.</p>
            <p>Story: Sgt. Vance Orion & IRIS vs. the Wobble Coalition and the dormant ringworld known as the Aureole.</p>
            <p style="color:var(--ink-dim)">Mechanics are recreated in the spirit of the genre; all characters, names, and content are original. Not affiliated with any other game.</p>
          </div>
          <div class="panel-foot"><span></span><button class="btn" data-act="back">Back</button></div>
        </div>
      </div>`;
    this.el.querySelector('[data-act="back"]').addEventListener('click', () => { this._click(); this.showMain(); });
  }

  // ---------------- Mission select ----------------
  showMissionSelect() {
    const p = loadProgress();
    this.clear();
    this.el.innerHTML = `
      <div class="screen">
        <div class="title-block"><div class="game-sub" style="color:var(--ink)">Mission Select</div></div>
        <div class="mission-grid"></div>
        <div class="menu-footer"><button class="btn ghost" data-act="back" style="margin-top:18px">← Back</button></div>
      </div>`;
    const grid = this.el.querySelector('.mission-grid');
    CAMPAIGN.forEach((m, i) => {
      const locked = i > p.unlocked;
      const tile = document.createElement('div');
      tile.className = 'mission-tile interactive' + (locked ? ' locked' : '');
      tile.innerHTML = `
        <span class="mt-lock">${locked ? '🔒' : (p.completed.includes(i) ? '✓' : '')}</span>
        <div class="mt-num">Mission ${i + 1}</div>
        <div class="mt-name">${m.name}</div>
        <div class="mt-beat">${m.brief.slice(0, 110)}${m.brief.length > 110 ? '…' : ''}</div>`;
      if (!locked) tile.addEventListener('click', () => { this._click(); this.h.onStart(i); });
      grid.appendChild(tile);
    });
    this.el.querySelector('[data-act="back"]').addEventListener('click', () => { this._click(); this.showMain(); });
  }

  // ---------------- Settings ----------------
  showSettings(tab, onBack, { fromPause = false } = {}) {
    this._settingsBack = onBack;
    this.clear();
    this.el.innerHTML = `
      <div class="screen">
        <div class="panel">
          <div class="panel-head"><h2>Settings</h2></div>
          <div class="tabs">
            <button class="tab" data-tab="controls">Controls</button>
            <button class="tab" data-tab="audio">Audio</button>
            <button class="tab" data-tab="video">Video</button>
            <button class="tab" data-tab="gameplay">Gameplay</button>
          </div>
          <div class="panel-body" id="settings-body"></div>
          <div class="panel-foot">
            <button class="btn ghost" data-act="reset">Reset to Defaults</button>
            <button class="btn primary" data-act="back">Done</button>
          </div>
        </div>
      </div>`;
    this.el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { this._click(); this._renderTab(t.dataset.tab); }));
    this.el.querySelector('[data-act="reset"]').addEventListener('click', () => { this._click(); this.settings.reset(); this._renderTab(this._curTab); });
    this.el.querySelector('[data-act="back"]').addEventListener('click', () => { this._click(); this.input.cancelRebind(); onBack && onBack(); });
    this._renderTab(tab || 'controls');
  }

  _renderTab(tab) {
    this._curTab = tab;
    this.el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const body = this.el.querySelector('#settings-body');
    body.innerHTML = '';
    if (tab === 'controls') this._renderControls(body);
    else if (tab === 'audio') this._renderAudio(body);
    else if (tab === 'gameplay') this._renderGameplay(body);
    else this._renderVideo(body);
  }

  _row(label, hint, controlEl) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const left = document.createElement('div');
    left.innerHTML = `<label>${label}</label>${hint ? `<span class="hint">${hint}</span>` : ''}`;
    const right = document.createElement('div');
    right.className = 'setting-control';
    right.appendChild(controlEl);
    row.append(left, right);
    return row;
  }

  _slider(path, min, max, step, fmt) {
    const wrap = document.createElement('div'); wrap.className = 'setting-control';
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = this.settings.get(path);
    const val = document.createElement('span'); val.className = 'range-val';
    const show = () => { val.textContent = (fmt ? fmt(input.value) : input.value); };
    show();
    input.addEventListener('input', () => { this.settings.set(path, parseFloat(input.value)); show(); });
    wrap.append(input, val);
    return wrap;
  }

  _toggle(path) {
    const b = document.createElement('button');
    b.className = 'toggle';
    const sync = () => { const v = this.settings.get(path); b.dataset.on = v; b.textContent = v ? 'ON' : 'OFF'; };
    sync();
    b.addEventListener('click', () => { this._click(); this.settings.set(path, !this.settings.get(path)); sync(); });
    return b;
  }

  _select(path, options) {
    const s = document.createElement('select');
    options.forEach((o) => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o[0].toUpperCase() + o.slice(1); s.appendChild(opt); });
    s.value = this.settings.get(path);
    s.addEventListener('change', () => { this._click(); this.settings.set(path, s.value); });
    return s;
  }

  _renderControls(body) {
    const note = document.createElement('div');
    note.className = 'hint'; note.style.margin = '0 0 8px';
    note.textContent = 'Click a binding, then press any key or mouse button. Esc cancels.';
    body.appendChild(note);
    ACTIONS.forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'rebind-btn';
      btn.textContent = codeLabel(this.settings.bindings[a.id]);
      btn.addEventListener('click', () => {
        this._click();
        this.el.querySelectorAll('.rebind-btn.listening').forEach((b) => b.classList.remove('listening'));
        btn.classList.add('listening'); btn.textContent = 'Press a key…';
        this.input.startRebind(a.id, () => {
          btn.classList.remove('listening');
          btn.textContent = codeLabel(this.settings.bindings[a.id]);
          // refresh in case the key was stolen from another action
          this._renderTab('controls');
        });
      });
      body.appendChild(this._row(a.label, '', btn));
    });
  }

  _renderAudio(body) {
    body.appendChild(this._row('Master Volume', '', this._slider('audio.master', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')));
    body.appendChild(this._row('Sound Effects', '', this._slider('audio.sfx', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')));
    body.appendChild(this._row('Music', '', this._slider('audio.music', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')));
    const test = document.createElement('button'); test.className = 'rebind-btn'; test.textContent = 'Test SFX';
    test.addEventListener('click', () => { this.audio.ensure(); this.audio.sfx('pistol'); });
    body.appendChild(this._row('Preview', 'Play a test sound', test));
  }

  _renderVideo(body) {
    body.appendChild(this._row('Graphics Quality', 'Shadows, pixel ratio, draw distance', this._select('video.quality', ['low', 'medium', 'high'])));
    body.appendChild(this._row('Field of View', '', this._slider('video.fov', 60, 110, 1, (v) => v + '°')));
    body.appendChild(this._row('Mouse Sensitivity', '', this._slider('mouse.sensitivity', 0.2, 3, 0.05, (v) => parseFloat(v).toFixed(2))));
    body.appendChild(this._row('ADS Sensitivity', 'Look speed while aiming', this._slider('mouse.adsScale', 0.2, 1, 0.05, (v) => parseFloat(v).toFixed(2))));
    body.appendChild(this._row('Invert Y Axis', '', this._toggle('mouse.invertY')));
    body.appendChild(this._row('Dynamic Shadows', '', this._toggle('video.shadows')));
    body.appendChild(this._row('Bloom / Glow', 'Soft glow on bright lights and projectiles', this._toggle('video.bloom')));
    body.appendChild(this._row('Motion Tracker', '', this._toggle('video.motionTracker')));
    body.appendChild(this._row('View Bob', '', this._toggle('video.viewBob')));
  }

  _renderGameplay(body) {
    const sel = document.createElement('select');
    DIFFICULTY_ORDER.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = DIFFICULTIES[k].name; sel.appendChild(o); });
    sel.value = this.settings.data.difficulty || 'trooper';
    const blurb = document.createElement('div');
    blurb.className = 'hint'; blurb.style.margin = '8px 4px 0';
    const upd = () => { blurb.textContent = DIFFICULTIES[sel.value].blurb; };
    upd();
    sel.addEventListener('change', () => { this._click(); this.settings.set('difficulty', sel.value); upd(); });
    body.appendChild(this._row('Difficulty', 'Scales enemy health and the damage you take', sel));
    body.appendChild(blurb);
  }

  // ---------------- Pause ----------------
  showPause() {
    this.clear();
    this.screen = 'pause';
    this.el.innerHTML = `
      <div class="screen">
        <div class="title-block"><div class="game-sub" style="color:var(--ink)">Paused</div></div>
        <div class="menu-list">
          <button class="btn primary" data-act="resume">▶ Resume</button>
          <button class="btn" data-act="settings">⚙ Settings</button>
          <button class="btn" data-act="restart">↻ Restart Mission</button>
          <button class="btn ghost" data-act="quit">⏏ Quit to Menu</button>
        </div>
      </div>`;
    this.el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      this._click();
      const a = b.dataset.act;
      if (a === 'resume') this.h.onResume();
      else if (a === 'settings') this.showSettings('controls', () => this.showPause(), { fromPause: true });
      else if (a === 'restart') this.h.onRestart();
      else if (a === 'quit') this.h.onQuit();
    }));
  }
}
