// Settings.js — persistent user settings + keybindings, saved to localStorage.
// Bindings map an ACTION name to a physical input code: keyboard codes like
// "KeyW"/"Space", or synthetic mouse codes "Mouse0" (left), "Mouse1" (middle),
// "Mouse2" (right). Input.js resolves physical events back to actions via this.

// v2: invalidates stores saved before the strafe-handedness fix, guaranteeing
// everyone gets the documented defaults (WASD move, R reload, F interact).
const STORE_KEY = 'webalo.settings.v2';

export const ACTIONS = [
  { id: 'forward', label: 'Move Forward' },
  { id: 'back', label: 'Move Back' },
  { id: 'left', label: 'Strafe Left' },
  { id: 'right', label: 'Strafe Right' },
  { id: 'jump', label: 'Jump' },
  { id: 'crouch', label: 'Crouch' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'fire', label: 'Fire' },
  { id: 'ads', label: 'Aim / Zoom' },
  { id: 'reload', label: 'Reload' },
  { id: 'melee', label: 'Melee' },
  { id: 'grenade', label: 'Throw Grenade' },
  { id: 'nadeswap', label: 'Cycle Grenade Type' },
  { id: 'swap', label: 'Swap Weapon' },
  { id: 'weapon1', label: 'Select Weapon 1' },
  { id: 'weapon2', label: 'Select Weapon 2' },
  { id: 'interact', label: 'Interact' },
  { id: 'flashlight', label: 'Flashlight' },
  { id: 'pause', label: 'Pause / Menu' },
];

const DEFAULTS = {
  bindings: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    jump: 'Space', crouch: 'ControlLeft', sprint: 'ShiftLeft',
    fire: 'Mouse0', ads: 'Mouse2',
    reload: 'KeyR', melee: 'KeyV', grenade: 'KeyG', nadeswap: 'KeyB',
    swap: 'KeyQ', weapon1: 'Digit1', weapon2: 'Digit2',
    interact: 'KeyF', flashlight: 'KeyT', pause: 'Escape',
  },
  mouse: { sensitivity: 1.0, adsScale: 0.6, invertY: false, padSensitivity: 1.0 },
  audio: { master: 0.8, sfx: 0.9, music: 0.5 },
  video: { quality: 'high', fov: 80, shadows: true, bloom: true, motionTracker: true, viewBob: true },
  difficulty: 'trooper',
};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k in over) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

export class Settings {
  constructor() {
    this.data = deepClone(DEFAULTS);
    this._listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.data = deepMerge(DEFAULTS, JSON.parse(raw));
    } catch (e) { /* corrupt store: keep defaults */ }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
    this._emit();
  }

  reset() {
    this.data = deepClone(DEFAULTS);
    this.save();
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) fn(this.data); }

  // dotted-path getter/setter: get('audio.master')
  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data);
  }
  set(path, value) {
    const keys = path.split('.');
    let o = this.data;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
    this.save();
  }

  get bindings() { return this.data.bindings; }
  setBinding(action, code) {
    // remove this code from any other action so we never double-bind a key
    for (const a in this.data.bindings) {
      if (this.data.bindings[a] === code && a !== action) this.data.bindings[a] = '';
    }
    this.data.bindings[action] = code;
    this.save();
  }
}

// Human-friendly label for a binding code, for the rebind UI.
export function codeLabel(code) {
  if (!code) return '—';
  const map = {
    Mouse0: 'L-Mouse', Mouse1: 'M-Mouse', Mouse2: 'R-Mouse',
    Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
    Space: 'Space', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', AltLeft: 'L-Alt', AltRight: 'R-Alt',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
