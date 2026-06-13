// TouchControls.js — on-screen controls for touch devices. Every desktop action
// is mirrored onto a thumb-reachable widget, and ALL of them drive the game
// through Input's virtual layer (setVirtual / addLook), so Player and Game read
// the same isDown()/pressed()/mouseDX they always have and need no touch code.
//
// Layout: a floating-origin movement stick (lower-left), a drag-to-look surface
// (right side), and action buttons clustered at the bottom-right. The FIRE and
// ADS buttons double as look surfaces while held, so you can aim one-thumbed
// while shooting. Pointer Events are used throughout for clean multi-touch.

const MOVE_ACTIONS = ['forward', 'back', 'left', 'right', 'sprint'];
const ALL_ACTIONS = [
  ...MOVE_ACTIONS, 'fire', 'ads', 'jump', 'crouch', 'reload', 'melee',
  'grenade', 'swap', 'interact', 'weapon1', 'weapon2', 'nadeswap', 'flashlight',
];

export class TouchControls {
  constructor(root, input, handlers = {}) {
    this.input = input;
    this.h = handlers;          // { onPause }
    this.lookSens = 2.8;        // touch-drag px -> look units (≈3x mouse, tuned)
    this._moveId = null;
    this._lookId = null;

    this.el = document.createElement('div');
    this.el.className = 'touch-controls hidden';
    this.el.innerHTML = `
      <div class="tc-look" data-tc="look"></div>
      <div class="tc-move" data-tc="move"><div class="tc-stick"><span class="tc-knob"></span></div></div>

      <div class="tc-util">
        <button class="tc-btn tc-mini tc-pause" data-act="pause" aria-label="Pause">❚❚</button>
        <button class="tc-btn tc-mini" data-hold="weapon1" aria-label="Weapon 1">1</button>
        <button class="tc-btn tc-mini" data-hold="weapon2" aria-label="Weapon 2">2</button>
        <button class="tc-btn tc-mini" data-hold="nadeswap" aria-label="Cycle grenade">G⇄</button>
        <button class="tc-btn tc-mini" data-hold="flashlight" aria-label="Flashlight">LAMP</button>
      </div>

      <button class="tc-btn tc-fire" data-hold="fire" data-look aria-label="Fire">FIRE</button>
      <div class="tc-actions">
        <button class="tc-btn tc-md" data-hold="ads" data-look aria-label="Aim">ADS</button>
        <button class="tc-btn tc-md" data-hold="jump" aria-label="Jump">JUMP</button>
        <button class="tc-btn tc-md" data-hold="reload" aria-label="Reload">RLD</button>
        <button class="tc-btn tc-md" data-hold="grenade" aria-label="Grenade">NADE</button>
        <button class="tc-btn tc-md" data-hold="melee" aria-label="Melee">MEL</button>
        <button class="tc-btn tc-md" data-hold="swap" aria-label="Swap weapon">SWAP</button>
        <button class="tc-btn tc-md" data-hold="interact" aria-label="Interact">USE</button>
        <button class="tc-btn tc-md" data-toggle="crouch" aria-label="Crouch">CRCH</button>
      </div>
    `;
    root.appendChild(this.el);
    this._bind();
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); this._releaseAll(); }

  _cap(el, e) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic/none */ } }

  // Release every virtual action + visual state, so nothing sticks down when the
  // controls vanish mid-hold (pause, death, quit).
  _releaseAll() {
    ALL_ACTIONS.forEach((a) => this.input.setVirtual(a, false));
    this._moveId = null;
    this._lookId = null;
    const stick = this.el.querySelector('.tc-stick');
    const knob = this.el.querySelector('.tc-knob');
    stick.classList.remove('active');
    knob.style.transform = '';
    this.el.querySelectorAll('.tc-btn.active').forEach((b) => b.classList.remove('active'));
  }

  _bind() {
    // ---- hold buttons: action down while pressed (auto-fire / grenade cook /
    //      ADS all fall out of this for free). data-look feeds drag to look. ----
    this.el.querySelectorAll('[data-hold]').forEach((b) => {
      const action = b.dataset.hold;
      const doLook = b.hasAttribute('data-look');
      let lx = 0, ly = 0;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this._cap(b, e);
        b.classList.add('active');
        this.input.setVirtual(action, true);
        lx = e.clientX; ly = e.clientY;
      });
      if (doLook) {
        b.addEventListener('pointermove', (e) => {
          if (!b.classList.contains('active')) return;
          this.input.addLook((e.clientX - lx) * this.lookSens, (e.clientY - ly) * this.lookSens);
          lx = e.clientX; ly = e.clientY;
        });
      }
      const up = (e) => { b.classList.remove('active'); this.input.setVirtual(action, false); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    });

    // ---- toggle buttons (crouch): tap to flip and latch ----
    this.el.querySelectorAll('[data-toggle]').forEach((b) => {
      const action = b.dataset.toggle;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const on = !b.classList.contains('active');
        b.classList.toggle('active', on);
        this.input.setVirtual(action, on);
      });
    });

    // ---- pause (direct callback, not an in-game action) ----
    this.el.querySelectorAll('[data-act="pause"]').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.h.onPause && this.h.onPause();
      });
    });

    // ---- look surface: drag anywhere on the right to turn/pitch ----
    const look = this.el.querySelector('[data-tc="look"]');
    let lkx = 0, lky = 0;
    look.addEventListener('pointerdown', (e) => {
      if (this._lookId !== null) return;
      this._lookId = e.pointerId; lkx = e.clientX; lky = e.clientY;
      this._cap(look, e);
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._lookId) return;
      this.input.addLook((e.clientX - lkx) * this.lookSens, (e.clientY - lky) * this.lookSens);
      lkx = e.clientX; lky = e.clientY;
    });
    const lookEnd = (e) => { if (e.pointerId === this._lookId) this._lookId = null; };
    look.addEventListener('pointerup', lookEnd);
    look.addEventListener('pointercancel', lookEnd);

    // ---- movement stick (floating origin: press anywhere in the zone) ----
    const move = this.el.querySelector('[data-tc="move"]');
    const stick = this.el.querySelector('.tc-stick');
    const knob = this.el.querySelector('.tc-knob');
    const R = 56;                 // max knob travel / full-throw radius (px)
    const DEAD = 0.30;            // direction deadzone (fraction of R)
    let ox = 0, oy = 0;
    move.addEventListener('pointerdown', (e) => {
      if (this._moveId !== null) return;
      this._moveId = e.pointerId;
      this._cap(move, e);
      ox = e.clientX; oy = e.clientY;
      const rect = move.getBoundingClientRect();
      stick.style.left = (e.clientX - rect.left) + 'px';
      stick.style.top = (e.clientY - rect.top) + 'px';
      stick.classList.add('active');
    });
    move.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._moveId) return;
      const dx = e.clientX - ox, dy = e.clientY - oy;
      const mag = Math.hypot(dx, dy);
      const cl = Math.min(mag, R);
      const ang = Math.atan2(dy, dx);
      knob.style.transform = `translate(${Math.cos(ang) * cl}px, ${Math.sin(ang) * cl}px)`;
      const nx = dx / R, ny = dy / R;       // up = -y = forward
      this.input.setVirtual('forward', ny < -DEAD);
      this.input.setVirtual('back', ny > DEAD);
      this.input.setVirtual('left', nx < -DEAD);
      this.input.setVirtual('right', nx > DEAD);
      // push the stick to its limit (forward) to break into a sprint
      this.input.setVirtual('sprint', mag / R > 0.92 && ny < -0.4);
    });
    const moveEnd = (e) => {
      if (e.pointerId !== this._moveId) return;
      this._moveId = null;
      MOVE_ACTIONS.forEach((a) => this.input.setVirtual(a, false));
      stick.classList.remove('active');
      knob.style.transform = '';
    };
    move.addEventListener('pointerup', moveEnd);
    move.addEventListener('pointercancel', moveEnd);
  }
}
