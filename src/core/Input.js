// Input.js — translates raw keyboard/mouse events into named ACTIONS using the
// current keybindings, manages pointer lock, accumulates mouse-look deltas, and
// supports interactive rebinding (capture the next physical input for an action).

// The fixed Xbox-style gamepad layout, surfaced in the UI (Settings reference,
// menu footer, tutorial). Single source of truth — pollGamepad() implements it.
// GAMEPAD_MAP is the human-readable reference list; GAMEPAD_BUTTONS is the
// per-action lookup the tutorial uses for inline labels.
export const GAMEPAD_MAP = [
  { label: 'Move', button: 'Left Stick' },
  { label: 'Look', button: 'Right Stick' },
  { label: 'Fire', button: 'RT' },
  { label: 'Aim / alt-fire', button: 'LT' },
  { label: 'Jump', button: 'Ⓐ' },
  { label: 'Melee', button: 'Ⓑ' },
  { label: 'Reload', button: 'Ⓧ' },
  { label: 'Swap weapon', button: 'Ⓨ' },
  { label: 'Grenade', button: 'RB' },
  { label: 'Interact / revive', button: 'LB' },
  { label: 'Sprint', button: 'L3 / push stick' },
  { label: 'Crouch', button: 'R3 (click R-stick)' },
  { label: 'Pause', button: 'Start' },
];
export const GAMEPAD_BUTTONS = {
  fire: 'RT', ads: 'LT', jump: 'Ⓐ', melee: 'Ⓑ', reload: 'Ⓧ', swap: 'Ⓨ',
  grenade: 'RB', interact: 'LB', crouch: 'R3', pause: 'Start', sprint: 'L3',
  forward: 'Left Stick', back: 'Left Stick', left: 'Left Stick', right: 'Left Stick',
};

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this._codeDown = new Set();      // physical codes currently held
    this._virtualDown = new Set();   // actions held via on-screen touch controls
    this._actionEdge = new Set();    // actions that went down THIS frame
    this._prevActionDown = new Set();

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = false;            // only true while actively playing
    this.lastSource = 'kbd';         // 'kbd' | 'pad' — last input device actively used (drives in-game prompts on desktop)

    this._rebindResolver = null;     // fn(code) when capturing a rebind
    this._onLockChange = null;

    // gamepad: polled each frame, drives the SAME virtual layer as touch
    this._gpActive = false;
    this._gpAsserted = new Set();    // virtuals the pad currently holds (so it only clears its own)
    this._gpStartPrev = false;
    this._gpStartEdge = false;
    this._navPrev = { confirm: false, back: false };       // gamepad menu-nav button edges
    this._navHold = { up: 0, down: 0, left: 0, right: 0 };  // direction auto-repeat frame counters

    this._bind();
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) { this._codeDown.clear(); this._actionEdge.clear(); this._virtualDown.clear(); }
  }
  onLockChange(fn) { this._onLockChange = fn; }

  // ---- Touch / virtual input ----------------------------------------------
  // On-screen touch controls drive ACTIONS through these. Folding them into the
  // same down-state means Player/Game keep reading isDown()/pressed() and never
  // need to know whether the input came from a key, a mouse, or a thumb.
  setVirtual(action, down) {
    if (down) this._virtualDown.add(action);
    else this._virtualDown.delete(action);
  }
  // Touch look: feed deltas straight into the accumulator the mouse uses. Pointer
  // lock never engages on touch, so this is gated on `enabled` only (not `locked`).
  addLook(dx, dy) { if (this.enabled) { this.mouseDX += dx; this.mouseDY += dy; } }

  // ---- Gamepad ------------------------------------------------------------
  // Polled once per frame BEFORE beginFrame(). Maps a standard controller onto
  // the virtual action layer + look accumulator, so a pad plays exactly like
  // mouse+keyboard/touch. Standard mapping (Xbox-style): left stick = move,
  // right stick = look, RT fire, LT ADS, A jump, B melee, X reload, Y swap,
  // RB grenade, LB interact, L3 sprint, R3 crouch, Start pause. It only clears the virtuals
  // it set, so it never stomps keyboard (which OR together) or touch.
  pollGamepad() {
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    this._gpActive = !!gp;
    const next = new Set();
    if (gp) {
      const DZ = 0.18, LOOK = 22 * (this.settings.data.mouse.padSensitivity || 1);
      const dz = (v) => (Math.abs(v) < DZ ? 0 : v);
      const a = gp.axes, b = gp.buttons;
      const down = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
      // move (left stick)
      const lx = dz(a[0] || 0), ly = dz(a[1] || 0);
      if (ly < -0.2) next.add('forward');
      if (ly > 0.2) next.add('back');
      if (lx < -0.2) next.add('left');
      if (lx > 0.2) next.add('right');
      if (Math.hypot(lx, ly) > 0.92 && ly < -0.4) next.add('sprint');
      // look (right stick) — squared response for fine aim, fed like mouse delta
      const rx = dz(a[2] || 0), ry = dz(a[3] || 0);
      if (rx || ry) this.addLook(rx * Math.abs(rx) * LOOK, ry * Math.abs(ry) * LOOK);
      // buttons -> actions
      if (down(7)) next.add('fire');      if (down(6)) next.add('ads');
      if (down(0)) next.add('jump');      if (down(1)) next.add('melee');
      if (down(2)) next.add('reload');    if (down(3)) next.add('swap');
      if (down(5)) next.add('grenade');   if (down(4)) next.add('interact');
      if (down(10)) next.add('sprint');   // L3: click-to-sprint (or push the stick fully)
      if (down(11)) next.add('crouch');   // R3: click the right stick to crouch
      const start = down(9);
      if (start && !this._gpStartPrev) this._gpStartEdge = true;
      this._gpStartPrev = start;
      // any active button/stick input marks the pad as the device in use
      if (next.size > 0 || start || lx || ly || rx || ry) this.lastSource = 'pad';
    } else {
      this._gpStartPrev = false;
    }
    for (const act of next) this.setVirtual(act, true);
    for (const act of this._gpAsserted) if (!next.has(act)) this.setVirtual(act, false);
    this._gpAsserted = next;
  }
  consumeGamepadPause() { const e = this._gpStartEdge; this._gpStartEdge = false; return e; }

  // Menu navigation from the pad, separate from gameplay polling. Directions
  // (D-pad / left stick) AUTO-REPEAT — fire on press, then again after a short
  // hold (so sliders ramp); A=confirm and B=back are one-shot edges. Read each
  // frame while NOT playing so a controller drives the menus + settings.
  pollMenuNav() {
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    const out = { active: !!gp, up: false, down: false, left: false, right: false, confirm: false, back: false };
    const hold = this._navHold;
    const rep = (on, key) => { if (!on) { hold[key] = 0; return false; } const h = hold[key]++; return h === 0 || (h > 16 && (h - 16) % 5 === 0); };
    if (gp) {
      const b = gp.buttons, a = gp.axes;
      const bd = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
      const lx = a[0] || 0, ly = a[1] || 0;
      out.up = rep(bd(12) || ly < -0.5, 'up');       // D-pad / left-stick up
      out.down = rep(bd(13) || ly > 0.5, 'down');
      out.left = rep(bd(14) || lx < -0.5, 'left');
      out.right = rep(bd(15) || lx > 0.5, 'right');
      const confirm = bd(0), back = bd(1);           // A / B (one-shot)
      out.confirm = confirm && !this._navPrev.confirm;
      out.back = back && !this._navPrev.back;
      this._navPrev = { confirm, back };
    } else {
      hold.up = hold.down = hold.left = hold.right = 0;
      this._navPrev = { confirm: false, back: false };
    }
    return out;
  }

  requestLock() { if (this.canvas.requestPointerLock) this.canvas.requestPointerLock(); }
  exitLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  // Begin capturing the next key/mouse press as the binding for `action`.
  startRebind(action, onDone) {
    this._rebindResolver = (code) => {
      this.settings.setBinding(action, code);
      this._rebindResolver = null;
      onDone && onDone(code);
    };
  }
  cancelRebind() { this._rebindResolver = null; }

  _codeForMouseButton(btn) { return 'Mouse' + btn; }

  _handleCapture(code) {
    if (!this._rebindResolver) return false;
    if (code === 'Escape') { this._rebindResolver = null; return true; } // cancel
    this._rebindResolver(code);
    return true;
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (this._handleCapture(e.code)) { e.preventDefault(); return; }
      this.lastSource = 'kbd';
      // Always let Escape through to the game (pause), even when not "enabled".
      if (this._codeDown.has(e.code)) return; // ignore auto-repeat
      this._codeDown.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this._codeDown.delete(e.code); });

    this.canvas.addEventListener('mousedown', (e) => {
      const code = this._codeForMouseButton(e.button);
      if (this._handleCapture(code)) { e.preventDefault(); return; }
      this.lastSource = 'kbd';
      this._codeDown.add(code);
    });
    // Capture-phase window listener so a rebind can grab a MOUSE button even
    // though the settings overlay sits over the canvas (the canvas handler above
    // never sees those clicks). Only acts while a rebind is pending, and stops
    // the click from also activating the menu button underneath.
    window.addEventListener('mousedown', (e) => {
      if (!this._rebindResolver) return;
      e.preventDefault(); e.stopPropagation();
      this._handleCapture(this._codeForMouseButton(e.button));
    }, true);
    window.addEventListener('mouseup', (e) => { this._codeDown.delete(this._codeForMouseButton(e.button)); });
    // prevent right-click context menu stealing the ADS button
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (this.locked && this.enabled) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });
    window.addEventListener('wheel', (e) => {
      if (this.enabled) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this._codeDown.clear();
      this._onLockChange && this._onLockChange(this.locked);
    });

    // Drop all held inputs if the tab loses focus (prevents "stuck keys").
    window.addEventListener('blur', () => { this._codeDown.clear(); this._virtualDown.clear(); });
  }

  _isCodeDown(action) {
    if (this._virtualDown.has(action)) return true;
    const code = this.settings.bindings[action];
    return code ? this._codeDown.has(code) : false;
  }

  // Call once per frame AFTER reading inputs, to compute edge transitions.
  beginFrame() {
    this._actionEdge.clear();
    const nowDown = new Set();
    for (const a in this.settings.bindings) {
      if (this._isCodeDown(a)) {
        nowDown.add(a);
        if (!this._prevActionDown.has(a)) this._actionEdge.add(a);
      }
    }
    this._prevActionDown = nowDown;
  }

  endFrame() { this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }

  isDown(action) { return this.enabled && this._isCodeDown(action); }
  pressed(action) { return this.enabled && this._actionEdge.has(action); } // edge: true only on the frame it went down
  takeWheel() { const w = this.wheel; return w; }
}
