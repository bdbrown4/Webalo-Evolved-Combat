// Input.js — translates raw keyboard/mouse events into named ACTIONS using the
// current keybindings, manages pointer lock, accumulates mouse-look deltas, and
// supports interactive rebinding (capture the next physical input for an action).

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

    this._rebindResolver = null;     // fn(code) when capturing a rebind
    this._onLockChange = null;

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
      // Always let Escape through to the game (pause), even when not "enabled".
      if (this._codeDown.has(e.code)) return; // ignore auto-repeat
      this._codeDown.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this._codeDown.delete(e.code); });

    this.canvas.addEventListener('mousedown', (e) => {
      const code = this._codeForMouseButton(e.button);
      if (this._handleCapture(code)) { e.preventDefault(); return; }
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
