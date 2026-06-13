// HUD.js — the in-game heads-up display, built as DOM over the canvas: shield +
// health bars, ammo/weapon + grenade readout, a reactive reticle, a radar-style
// motion tracker (canvas), objective banner, subtitle line, big event banners,
// interaction prompt, damage vignette. Driven each frame by Player.hudState().

export class HUD {
  constructor(root, settings) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="reticle"><span class="r up"></span><span class="r down"></span><span class="r left"></span><span class="r right"></span></div>
      <div id="turret-reticle" class="hidden"><span class="tr-ring"></span><span class="tr-dot"></span></div>
      <div id="cook" class="hidden"><div class="cook-fill"></div></div>
      <div id="scope" class="hidden"><div class="scope-cross h"></div><div class="scope-cross v"></div><div class="scope-zoom"></div></div>
      <div class="objective"><div class="o-label">Objective</div><div class="o-text" id="o-text">—</div></div>
      <div id="boss-bar" class="hidden"><div class="bb-name"></div><div class="bb-track"><div class="bb-fill"></div></div><div class="bb-phase"></div></div>
      <div id="miniboss-bar" class="hidden">
        <div class="mb-head"><span class="mb-tag">◆ Mini-Boss</span><span class="mb-name"></span></div>
        <div class="mb-bar mb-shield-bar"><div class="mb-shield"></div></div>
        <div class="mb-bar mb-hp-bar"><div class="mb-hp"></div></div>
      </div>
      <div class="vitals">
        <div class="label">Shields</div>
        <div class="bar shield" id="shield-bar"><div class="fill"></div></div>
        <div class="label">Health</div>
        <div class="bar health" id="health-bar"><div class="fill"></div></div>
      </div>
      <div class="ammo" id="ammo-box">
        <div class="wname" id="w-name">—</div>
        <div class="count"><span id="ammo-cur">0</span><span class="reserve">/<span id="ammo-res">0</span></span></div>
        <div class="nades">Grenade: <b id="nade-type">FRAG</b> <span id="nade-count">x2</span></div>
        <div class="wstow" id="w-stow"></div>
      </div>
      <canvas id="tracker" width="132" height="132"></canvas>
      <div id="subtitle" class="hidden"></div>
      <div id="banner" class="hidden"><div class="big"></div><div class="small"></div></div>
      <div id="prompt" class="hidden"></div>
    `;
    root.appendChild(this.el);
    this.flash = document.createElement('div'); this.flash.id = 'damage-flash'; root.appendChild(this.flash);

    this.$ = (id) => this.el.querySelector(id);
    this.shieldFill = this.$('#shield-bar .fill');
    this.healthFill = this.$('#health-bar .fill');
    this.tracker = this.$('#tracker');
    this.tctx = this.tracker.getContext('2d');
    this._subQueue = [];
    this._subT = 0;
    this._bannerT = 0;
    this._escape = null;
  }

  show(v) { this.el.classList.toggle('hidden', !v); this.flash.classList.toggle('hidden', !v); }

  // Hide per-frame combat overlays when leaving play (they're only rewritten by
  // update(), which stops the moment the state leaves 'playing' — without this
  // a scope mask or cook bar would freeze on screen under the result banner).
  clearTransients() {
    this.$('#scope').classList.add('hidden');
    this.$('#cook').classList.add('hidden');
    this.$('#reticle').classList.remove('hidden');
  }

  setObjective(text) { this.$('#o-text').textContent = text; }

  setReticle(kind) {
    const r = this.$('#reticle');
    const gap = { dot: 4, cross: 7, circle: 9, spread: 12 }[kind] || 7;
    r.querySelector('.up').style.height = r.querySelector('.down').style.height = (gap) + 'px';
    r.querySelector('.left').style.width = r.querySelector('.right').style.width = (gap) + 'px';
  }

  hitMark() {
    const r = this.$('#reticle');
    r.classList.add('hit');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => r.classList.remove('hit'), 90);
  }

  setPrompt(text) {
    const p = this.$('#prompt');
    if (text) { p.textContent = text; p.classList.remove('hidden'); }
    else p.classList.add('hidden');
  }

  // IRIS turret reticle while driving. info = { x, y, locked } in NDC, or null.
  setTurret(info) {
    const t = this.$('#turret-reticle');
    if (!info) { t.classList.add('hidden'); return; }
    t.classList.remove('hidden');
    t.style.left = ((info.x * 0.5 + 0.5) * 100) + '%';
    t.style.top = ((-info.y * 0.5 + 0.5) * 100) + '%';
    t.classList.toggle('locked', !!info.locked);
  }

  banner(big, small, seconds = 1.4) {
    const b = this.$('#banner');
    b.className = '';
    if (big === 'MISSION COMPLETE' || big === 'SYSTEM ONLINE' || big === 'PICKED UP') b.classList.add('win');
    if (big === 'DOWN' || big === 'FAILED') b.classList.add('lose');
    b.querySelector('.big').textContent = big;
    b.querySelector('.small').textContent = small || '';
    b.classList.remove('hidden');
    this._bannerT = seconds;
  }

  queueDialogue(lines) {
    for (const l of (lines || [])) this._subQueue.push(l);
  }

  setEscape(t) { this._escape = t; }

  update(dt, state, enemies, player) {
    // bars
    this.shieldFill.style.width = (100 * state.shield / state.shieldMax) + '%';
    this.healthFill.style.width = (100 * state.health / state.healthMax) + '%';
    this.$('#shield-bar').classList.toggle('broken', state.shield <= 0);
    // ammo
    this.$('#w-name').textContent = state.weapon;
    this.$('#ammo-cur').textContent = state.ammo;
    this.$('#ammo-res').textContent = state.reserve;
    this.$('#nade-type').textContent = state.grenadeType.toUpperCase();
    this.$('#nade-count').textContent = 'x' + state.grenades[state.grenadeType];
    this.$('#ammo-box').classList.toggle('reloading', state.reloading);
    this.$('#w-stow').textContent = state.stowed ? '⇆ ' + state.stowed : '';
    // pulse the weapon name when it changes (swap feedback)
    if (state.weapon !== this._lastWeapon) {
      if (this._lastWeapon !== undefined && state.weapon !== '—') {
        const wn = this.$('#w-name');
        wn.classList.remove('swapped'); void wn.offsetWidth; // restart the animation
        wn.classList.add('swapped');
      }
      this._lastWeapon = state.weapon;
    }
    this.setReticle(state.reticle);

    // grenade cook bar under the reticle
    const cook = this.$('#cook');
    if (state.cook != null) {
      cook.classList.remove('hidden');
      cook.querySelector('.cook-fill').style.width = (state.cook * 100) + '%';
      cook.classList.toggle('hot', state.cook < 0.35);
    } else cook.classList.add('hidden');

    // scope overlay (replaces the reticle while zoomed on a scoped weapon).
    // Driving hands the crosshair over to the IRIS turret reticle entirely.
    const scope = this.$('#scope');
    scope.classList.toggle('hidden', !state.scoped || state.driving);
    this.$('#reticle').classList.toggle('hidden', !!state.scoped || !!state.driving);
    if (state.scoped) scope.querySelector('.scope-zoom').textContent = state.scopeZoom.toFixed(1) + '×';

    // damage vignette
    this.flash.classList.toggle('lowshield', state.lowShield);
    if (state.hitFlash) { this.flash.style.boxShadow = 'inset 0 0 220px rgba(255,40,40,0.5)'; }
    else { this.flash.style.boxShadow = 'none'; }

    // subtitles
    this._subT -= dt;
    const sub = this.$('#subtitle');
    if (this._subT <= 0 && this._subQueue.length) {
      const l = this._subQueue.shift();
      this._subT = Math.max(2.4, l.line.length * 0.045);
      sub.innerHTML = `<span class="spk">${l.speaker}:</span> ${l.line}`;
      sub.classList.toggle('enemy', !['IRIS', 'Vanguard'].includes(l.speaker));
      sub.classList.remove('hidden');
    } else if (this._subT <= 0) {
      sub.classList.add('hidden');
    }

    // banner timeout
    if (this._bannerT > 0) { this._bannerT -= dt; if (this._bannerT <= 0) this.$('#banner').classList.add('hidden'); }

    // escape countdown shown in objective slot
    if (this._escape != null) this.setObjective('⚠ RING COLLAPSE — ' + this._escape.toFixed(1) + 's');

    // boss health bar (shown while a boss enemy is alive)
    const boss = enemies && enemies.find((e) => e.type === 'boss' && !e.dead);
    const bb = this.$('#boss-bar');
    if (boss) {
      bb.classList.remove('hidden');
      bb.querySelector('.bb-name').textContent = (boss.meta && boss.meta.name) || 'BOSS';
      bb.querySelector('.bb-fill').style.width = (100 * Math.max(0, boss.hp) / boss.maxHp) + '%';
      bb.querySelector('.bb-phase').textContent = 'Phase ' + (boss.bossPhase || 1) + ' / 3';
    } else {
      bb.classList.add('hidden');
    }

    // mini-boss bar (Quivermaster Sprocket and kin). On foot only — the finale
    // drive treats them as turret fodder, so no bar swings up mid-chase.
    const mini = (!state.driving && enemies) ? enemies.find((e) => e.meta && e.meta.miniboss && !e.dead) : null;
    const mb = this.$('#miniboss-bar');
    if (mini) {
      mb.classList.remove('hidden');
      mb.querySelector('.mb-name').textContent = mini.meta.name;
      mb.querySelector('.mb-hp').style.width = (100 * Math.max(0, mini.hp) / mini.maxHp) + '%';
      this.$('.mb-shield-bar').style.opacity = mini.maxShield ? '1' : '0';
      mb.querySelector('.mb-shield').style.width = (mini.maxShield ? 100 * Math.max(0, mini.shield) / mini.maxShield : 0) + '%';
      if (!this._minibossOn) { this._minibossOn = true; this.banner('◆ MINI-BOSS', mini.meta.name, 2.0); }
    } else {
      mb.classList.add('hidden');
      this._minibossOn = false;
    }

    this._drawTracker(enemies, player);
  }

  _drawTracker(enemies, player) {
    if (!this.settings.data.video.motionTracker) { this.tracker.style.display = 'none'; return; }
    this.tracker.style.display = 'block';
    const c = this.tctx, W = 132, H = 132, cx = W / 2, cy = H / 2, R = 60, range = 34;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(8,18,24,0.6)'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(95,208,230,0.5)'; c.lineWidth = 1.5; c.stroke();
    c.strokeStyle = 'rgba(95,208,230,0.18)';
    c.beginPath(); c.arc(cx, cy, R * 0.6, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, R * 0.3, 0, Math.PI * 2); c.stroke();
    // player heading marker
    c.fillStyle = '#5fd0e6'; c.beginPath(); c.moveTo(cx, cy - 6); c.lineTo(cx - 4, cy + 4); c.lineTo(cx + 4, cy + 4); c.closePath(); c.fill();
    if (!player) return;
    const yaw = player.yaw;
    for (const e of enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      // project onto the player's facing axes: forward = up on the dial,
      // screen-right = right (right vector is (-cos yaw, sin yaw) in this world)
      const rx = -dx * Math.cos(yaw) + dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const px = cx + (rx / range) * R;
      const py = cy - (rz / range) * R;
      c.fillStyle = e.type === 'boss' ? '#ff5a8c' : '#ff5a5a';
      c.beginPath(); c.arc(px, py, e.type === 'boss' ? 5 : 3, 0, Math.PI * 2); c.fill();
    }
  }
}
