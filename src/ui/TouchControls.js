// TouchControls.js — a standard, familiar mobile-FPS scheme:
//
//   • LEFT  — a floating movement stick (push fully forward to sprint / boost).
//   • RIGHT — a LOOK area: drag your thumb to turn/aim (camera on foot, turret
//     reticle while driving). A quick tap fires one shot; double-tap reloads;
//     a second finger throws a grenade.
//   • A big FIRE button (hold for sustained fire) sits under the right thumb,
//     with RELOAD / NADE / ADS / JUMP / SWAP, a contextual USE, and PAUSE.
//
// Looking is routed through Input.addLook() — the very same mouseDX/mouseDY the
// mouse and the vehicle turret already read — so drag-to-look works identically
// on foot and in the IRIS turret with no special-casing. Firing is owned by the
// Game (single writer of the 'fire' virtual): this class just exposes fireHeld
// and a one-shot tapFire flag, plus runs soft aim-assist off the centred reticle.

const MOVE_ACTIONS = ['forward', 'back', 'left', 'right', 'sprint'];
const ALL_ACTIONS = [...MOVE_ACTIONS, 'fire', 'ads', 'jump', 'grenade', 'swap', 'interact', 'reload', 'melee', 'crouch', 'nadeswap', 'flashlight'];

// Touch look feels right at ~3x the mouse path (default sensitivity 1.0): a
// thumb swipe of ~200px turns ~75° on foot. Respects the sensitivity slider.
const LOOK = 3.0;

export class TouchControls {
  constructor(root, input, handlers = {}, settings = null) {
    this.input = input;
    this.h = handlers;            // { onPause }
    this.settings = settings;     // mirrors the layout when gameplay.leftHanded flips
    this._moveId = null;
    this._lookId = null;
    this._secondId = null;
    this.fireHeld = false;        // FIRE button held (Game reads this)
    this.tapFire = false;         // one-shot: a quick tap on the look pad (Game consumes)
    this._lx = 0; this._ly = 0;   // last look-pad position (for drag deltas)
    this._downT = 0; this._downX = 0; this._downY = 0; this._moved = 0; this._lastTapT = 0;

    this.el = document.createElement('div');
    this.el.className = 'touch-controls hidden';
    this.el.innerHTML = `
      <div class="tc-look" data-tc="look"></div>
      <div class="tc-move" data-tc="move"><div class="tc-stick"><span class="tc-knob"></span></div></div>

      <button class="tc-btn tc-fire" data-hold="fire" aria-label="Fire">FIRE</button>
      <div class="tc-actions">
        <button class="tc-btn tc-md" data-hold="ads" aria-label="Aim down sight">ADS</button>
        <button class="tc-btn tc-md" data-tap="melee" aria-label="Melee">MELEE</button>
        <button class="tc-btn tc-md" data-hold="swap" aria-label="Swap weapon">SWAP</button>
      </div>
      <div class="tc-right2">
        <button class="tc-btn tc-md" data-tap="reload" aria-label="Reload">RELOAD</button>
        <button class="tc-btn tc-md" data-tap="grenade" aria-label="Grenade">NADE</button>
        <button class="tc-btn tc-md" data-hold="jump" aria-label="Jump">JUMP</button>
      </div>
      <div class="tc-util">
        <button class="tc-btn tc-mini" data-hold="crouch" aria-label="Crouch">DUCK</button>
        <button class="tc-btn tc-mini" data-tap="nadeswap" aria-label="Cycle grenade type">N-TYPE</button>
        <button class="tc-btn tc-mini" data-tap="flashlight" aria-label="Flashlight">TORCH</button>
      </div>

      <button class="tc-btn tc-mini tc-pause" data-act="pause" aria-label="Pause">❚❚</button>
      <button class="tc-btn tc-use hidden" data-hold="interact" aria-label="Use">USE</button>

      <div class="tc-hint" aria-hidden="true">Drag right to aim · tap to shoot · hold <b>FIRE</b> for auto</div>
    `;
    root.appendChild(this.el);
    this._bind();
    if (settings) {
      const applyHand = () => this.el.classList.toggle('lefty', !!settings.data.gameplay?.leftHanded);
      applyHand();
      settings.onChange(applyHand);
    }
  }

  show() {
    this.el.classList.remove('hidden');
    // First-play hint: show once per session, fade after a few seconds.
    if (!this._hintShown) {
      this._hintShown = true;
      const hint = this.el.querySelector('.tc-hint');
      hint.classList.add('show');
      this._hintTimer = setTimeout(() => hint.classList.remove('show'), 4200);
    }
  }
  hide() { this.el.classList.add('hidden'); this._releaseAll(); }
  // Contextual Use button — shown by the Game only when an interact prompt is up.
  setInteract(on) { this.el.querySelector('.tc-use').classList.toggle('hidden', !on); }

  _cap(el, e) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic/none */ } }
  // Momentary virtual press (for the tap-buttons: reload / grenade).
  _pulse(action) { this.input.setVirtual(action, true); setTimeout(() => this.input.setVirtual(action, false), 80); }

  _releaseAll() {
    ALL_ACTIONS.forEach((a) => this.input.setVirtual(a, false));
    this._moveId = this._lookId = this._secondId = null;
    this.fireHeld = false; this.tapFire = false;
    const stick = this.el.querySelector('.tc-stick');
    const knob = this.el.querySelector('.tc-knob');
    stick.classList.remove('active'); knob.style.transform = '';
    this.el.querySelectorAll('.tc-btn.active').forEach((b) => b.classList.remove('active'));
  }

  _bind() {
    // ---- hold buttons (fire / jump / ads / swap / interact) ----
    this.el.querySelectorAll('[data-hold]').forEach((b) => {
      const action = b.dataset.hold;
      const down = (e) => {
        e.preventDefault(); e.stopPropagation();
        this._cap(b, e); b.classList.add('active');
        if (action === 'fire') this.fireHeld = true;       // Game owns the 'fire' virtual
        else this.input.setVirtual(action, true);
      };
      const up = () => {
        b.classList.remove('active');
        if (action === 'fire') this.fireHeld = false;
        else this.input.setVirtual(action, false);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    });

    // ---- tap buttons (reload / grenade): momentary pulse ----
    this.el.querySelectorAll('[data-tap]').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        b.classList.add('active'); this._pulse(b.dataset.tap);
        setTimeout(() => b.classList.remove('active'), 120);
      });
    });

    // ---- pause ----
    this.el.querySelector('.tc-pause').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this.h.onPause && this.h.onPause();
    });

    // ---- LOOK pad: drag to aim, tap to fire, double-tap reload, 2-finger nade ----
    const look = this.el.querySelector('[data-tc="look"]');
    look.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this._lookId === null) {
        this._lookId = e.pointerId; this._cap(look, e);
        this._lx = e.clientX; this._ly = e.clientY;
        this._downT = performance.now(); this._downX = e.clientX; this._downY = e.clientY; this._moved = 0;
      } else if (this._secondId === null) {
        // a second finger on the look pad throws a grenade (prime now, release on lift)
        this._secondId = e.pointerId; this.input.setVirtual('grenade', true);
      }
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._lookId) return;
      const dx = e.clientX - this._lx, dy = e.clientY - this._ly;
      this._lx = e.clientX; this._ly = e.clientY;
      this._moved += Math.hypot(dx, dy);
      this.input.addLook(dx * LOOK, dy * LOOK);   // same path as the mouse → turns view / turret
    });
    const lookUp = (e) => {
      if (e.pointerId === this._secondId) { this._secondId = null; this.input.setVirtual('grenade', false); return; }
      if (e.pointerId !== this._lookId) return;
      this._lookId = null;
      // If the look finger lifts/cancels while a 2nd finger had primed a grenade,
      // release it now — otherwise the 'grenade' virtual could stay stuck on and
      // the primed frag would self-detonate. Clearing it lets the cook throw it.
      if (this._secondId !== null) { this._secondId = null; this.input.setVirtual('grenade', false); }
      const now = performance.now();
      const isTap = (now - this._downT) < 240 && this._moved < 16;
      if (isTap) {
        if (now - this._lastTapT < 320) { this._pulse('reload'); this._lastTapT = 0; } // double-tap reload
        else { this.tapFire = true; this._lastTapT = now; }                            // single tap fires one shot
      }
    };
    look.addEventListener('pointerup', lookUp);
    look.addEventListener('pointercancel', lookUp);

    // ---- movement stick (floating origin) ----
    const move = this.el.querySelector('[data-tc="move"]');
    const stick = this.el.querySelector('.tc-stick');
    const knob = this.el.querySelector('.tc-knob');
    const R = 56, DEAD = 0.30;
    let ox = 0, oy = 0;
    move.addEventListener('pointerdown', (e) => {
      if (this._moveId !== null) return;
      this._moveId = e.pointerId; this._cap(move, e);
      ox = e.clientX; oy = e.clientY;
      const rect = move.getBoundingClientRect();
      stick.style.left = (e.clientX - rect.left) + 'px';
      stick.style.top = (e.clientY - rect.top) + 'px';
      stick.classList.add('active');
    });
    move.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._moveId) return;
      const dx = e.clientX - ox, dy = e.clientY - oy;
      const mag = Math.hypot(dx, dy), cl = Math.min(mag, R), ang = Math.atan2(dy, dx);
      knob.style.transform = `translate(${Math.cos(ang) * cl}px, ${Math.sin(ang) * cl}px)`;
      const nx = dx / R, ny = dy / R;
      this.input.setVirtual('forward', ny < -DEAD);
      this.input.setVirtual('back', ny > DEAD);
      this.input.setVirtual('left', nx < -DEAD);
      this.input.setVirtual('right', nx > DEAD);
      this.input.setVirtual('sprint', mag / R > 0.92 && ny < -0.4); // full forward = sprint / boost
    });
    const moveEnd = (e) => {
      if (e.pointerId !== this._moveId) return;
      this._moveId = null;
      MOVE_ACTIONS.forEach((a) => this.input.setVirtual(a, false));
      stick.classList.remove('active'); knob.style.transform = '';
    };
    move.addEventListener('pointerup', moveEnd);
    move.addEventListener('pointercancel', moveEnd);
  }
}
