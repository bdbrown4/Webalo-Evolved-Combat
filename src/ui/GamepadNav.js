// GamepadNav.js — drives the DOM menus with a controller while NOT playing.
//
// Every frame (from main.js) step() reads one-shot nav edges from Input and moves
// a focus highlight over the on-screen, interactive elements: buttons, tabs,
// rebind buttons, toggles, sliders, dropdowns, mission tiles, perk cards. A
// confirms (clicks); B backs out; left/right adjust a focused slider or dropdown
// (and step between tabs). It re-queries the DOM each frame, so it follows screen
// changes automatically and never holds stale nodes.

const FOCUSABLE = '.tab, .btn, .rebind-btn, .toggle, input[type="range"], select, .mission-tile, .perk-card';

export class GamepadNav {
  constructor(root, input, game) {
    this.root = root; this.input = input; this.game = game;
    this.els = []; this.idx = -1;
  }

  _focusables() {
    return Array.from(this.root.querySelectorAll(FOCUSABLE))
      .filter((el) => !el.disabled && el.offsetParent !== null && !el.classList.contains('locked'));
  }
  _apply() {
    this.els.forEach((el, i) => el.classList.toggle('gp-focus', i === this.idx));
    const cur = this.els[this.idx];
    if (cur && cur.offsetParent !== null) cur.scrollIntoView({ block: 'nearest' });
  }
  clear() { this.els.forEach((el) => el.parentElement && el.classList.remove('gp-focus')); this.els = []; this.idx = -1; }

  step() {
    if (this.game.state === 'playing') { if (this.els.length) this.clear(); return; }
    const nav = this.input.pollMenuNav();
    if (!nav.active) { if (this.els.length) this.clear(); return; }
    // A rebind is capturing a key — a controller can't press a key/Esc to finish or
    // cancel, so let Ⓑ abort it (and swallow nav so we don't also click "back").
    if (this.input.isRebinding()) { if (nav.back) this.input.cancelRebind(); return; }
    const els = this._focusables();
    const same = els.length === this.els.length && els.every((e, i) => e === this.els[i]);
    this.els = els;
    if (!same) { this.idx = els.length ? 0 : -1; this._apply(); }   // screen changed → focus the first item
    if (!els.length) return;
    if (nav.up) { this.idx = (this.idx - 1 + els.length) % els.length; this._apply(); }
    if (nav.down) { this.idx = (this.idx + 1) % els.length; this._apply(); }
    const cur = els[this.idx];
    if (nav.left) this._adjust(cur, -1);
    if (nav.right) this._adjust(cur, 1);
    if (nav.confirm && cur) this._activate(cur);
    if (nav.back) {
      const b = this.root.querySelector('[data-act="back"], [data-act="cancel"], [data-act="resume"], [data-act="leave"], [data-act="menu"]');
      if (b && b.offsetParent !== null) b.click();
    }
  }

  // left/right: nudge a slider, cycle a dropdown, or step between tabs
  _adjust(el, dir) {
    if (!el) return;
    if (el.tagName === 'INPUT' && el.type === 'range') {
      const step = parseFloat(el.step) || 1, min = parseFloat(el.min), max = parseFloat(el.max);
      const v = Math.max(min, Math.min(max, parseFloat(el.value) + dir * step));
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const n = el.options.length; if (!n) return;
      el.selectedIndex = (el.selectedIndex + dir + n) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.classList.contains('tab')) {
      const tabs = Array.from(this.root.querySelectorAll('.tab'));
      const next = tabs[(tabs.indexOf(el) + dir + tabs.length) % tabs.length];
      if (next) { next.click(); this._refocusTab(); }
    }
  }

  // A: activate a button/tab/toggle/rebind; cycle a dropdown; sliders use left/right.
  // Pressing A on a tab opens it and drops focus INTO the panel (its first control),
  // so you head straight into the settings; left/right still cycles tabs in place.
  _activate(el) {
    if (el.tagName === 'INPUT' && el.type === 'range') return;
    if (el.tagName === 'SELECT') { this._adjust(el, 1); return; }
    const wasTab = el.classList.contains('tab');
    el.click();
    if (wasTab) this._focusFirstContent();
  }

  // after a tab switch the body re-renders — keep the highlight on the active tab
  // (used by left/right tab cycling so you can keep stepping through the row)
  _refocusTab() {
    const els = this._focusables();
    this.els = els;
    const ai = els.findIndex((e) => e.classList.contains('tab') && e.classList.contains('active'));
    this.idx = ai >= 0 ? ai : (els.length ? 0 : -1);
    this._apply();
  }

  // after confirming a tab, move the highlight onto the first non-tab control in
  // the newly shown panel (falling back to the tab row if the panel is empty)
  _focusFirstContent() {
    const els = this._focusables();
    this.els = els;
    const i = els.findIndex((e) => !e.classList.contains('tab'));
    this.idx = i >= 0 ? i : (els.length ? 0 : -1);
    this._apply();
  }
}
