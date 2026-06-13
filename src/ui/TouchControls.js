// TouchControls.js — a deliberately minimal touch scheme:
//
//   • LEFT  — a floating movement stick (push fully forward to sprint / boost).
//   • RIGHT — an aim+FIRE pad. Touch where the enemy is and you shoot it: the
//     game turns your view toward the nearest enemy under your finger (on foot)
//     or slides the turret reticle there (driving), and fires while held.
//   • Gestures on the pad: double-tap = reload, two-finger tap = throw grenade.
//   • A tiny button set (Jump / ADS / Swap), a contextual Use, and Pause.
//
// Everything drives the game through Input's virtual layer, so Player/Game read
// the same isDown()/pressed()/mouseDX they always have. The Game reads aimActive
// + aimPt each frame to run the aim assist.

const MOVE_ACTIONS = ['forward', 'back', 'left', 'right', 'sprint'];
const ALL_ACTIONS = [...MOVE_ACTIONS, 'fire', 'ads', 'jump', 'grenade', 'swap', 'interact', 'reload'];

export class TouchControls {
  constructor(root, input, handlers = {}) {
    this.input = input;
    this.h = handlers;            // { onPause }
    this._moveId = null;
    this._aimId = null;
    this._secondId = null;
    this.aimActive = false;       // a finger is on the aim pad (Game reads this)
    this.aimPt = { x: 0, y: 0 };  // that finger in NDC (-1..1), x right / y up
    this._downT = 0; this._downX = 0; this._downY = 0; this._lastTapT = 0;

    this.el = document.createElement('div');
    this.el.className = 'touch-controls hidden';
    this.el.innerHTML = `
      <div class="tc-aim" data-tc="aim"></div>
      <div class="tc-move" data-tc="move"><div class="tc-stick"><span class="tc-knob"></span></div></div>

      <button class="tc-btn tc-mini tc-pause" data-act="pause" aria-label="Pause">❚❚</button>
      <button class="tc-btn tc-use hidden" data-hold="interact" aria-label="Use">USE</button>
      <div class="tc-actions">
        <button class="tc-btn tc-md" data-hold="ads" aria-label="Aim">ADS</button>
        <button class="tc-btn tc-md" data-hold="swap" aria-label="Swap weapon">SWAP</button>
        <button class="tc-btn tc-md" data-hold="jump" aria-label="Jump">JUMP</button>
      </div>
    `;
    root.appendChild(this.el);
    this._bind();
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); this._releaseAll(); }
  // Contextual Use button — shown by the Game only when an interact prompt is up.
  setInteract(on) { this.el.querySelector('.tc-use').classList.toggle('hidden', !on); }

  _cap(el, e) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic/none */ } }
  _pulse(action) { this.input.setVirtual(action, true); setTimeout(() => this.input.setVirtual(action, false), 70); }

  _releaseAll() {
    ALL_ACTIONS.forEach((a) => this.input.setVirtual(a, false));
    this._moveId = this._aimId = this._secondId = null;
    this.aimActive = false;
    const stick = this.el.querySelector('.tc-stick');
    const knob = this.el.querySelector('.tc-knob');
    stick.classList.remove('active'); knob.style.transform = '';
    this.el.querySelectorAll('.tc-btn.active').forEach((b) => b.classList.remove('active'));
  }

  _bind() {
    // ---- hold buttons (jump / ads / swap / interact) ----
    this.el.querySelectorAll('[data-hold]').forEach((b) => {
      const action = b.dataset.hold;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._cap(b, e); b.classList.add('active'); this.input.setVirtual(action, true);
      });
      const up = () => { b.classList.remove('active'); this.input.setVirtual(action, false); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    });

    // ---- pause ----
    this.el.querySelector('.tc-pause').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this.h.onPause && this.h.onPause();
    });

    // ---- aim + fire pad ----
    const aim = this.el.querySelector('[data-tc="aim"]');
    const setPt = (e) => {
      this.aimPt.x = (e.clientX / (window.innerWidth || 1)) * 2 - 1;
      this.aimPt.y = -((e.clientY / (window.innerHeight || 1)) * 2 - 1);
    };
    aim.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this._aimId === null) {
        this._aimId = e.pointerId; this._cap(aim, e);
        this.aimActive = true; setPt(e); this.input.setVirtual('fire', true);
        this._downT = performance.now(); this._downX = e.clientX; this._downY = e.clientY;
      } else if (this._secondId === null) {
        // a second finger on the pad throws a grenade (prime now, release on lift)
        this._secondId = e.pointerId; this.input.setVirtual('grenade', true);
      }
    });
    aim.addEventListener('pointermove', (e) => { if (e.pointerId === this._aimId) setPt(e); });
    const aimUp = (e) => {
      if (e.pointerId === this._secondId) { this._secondId = null; this.input.setVirtual('grenade', false); return; }
      if (e.pointerId !== this._aimId) return;
      this._aimId = null; this.aimActive = false; this.input.setVirtual('fire', false);
      const now = performance.now();
      const tap = (now - this._downT) < 250 && Math.hypot(e.clientX - this._downX, e.clientY - this._downY) < 26;
      if (tap) {
        if (now - this._lastTapT < 350) { this._pulse('reload'); this._lastTapT = 0; } // double-tap reload
        else this._lastTapT = now;
      }
    };
    aim.addEventListener('pointerup', aimUp);
    aim.addEventListener('pointercancel', aimUp);

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
