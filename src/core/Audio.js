// Audio.js — all sound is SYNTHESIZED at runtime via the Web Audio API.
// No audio files ship with the game. SFX are short procedural blips/noise
// bursts; music is a few layered oscillators with a slow filter sweep whose
// intensity adapts to the track (ambient / tension / combat / finale).

export class Audio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this._noiseBuf = null;
    this._music = null;
    this._track = null;
    settings.onChange(() => this._applyVolumes());
    // Mobile browsers suspend the context when the tab backgrounds (or a call comes
    // in); without this, the game returns SILENT until the next menu click.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      });
    }
  }

  // Must be called from a user gesture (click) to satisfy autoplay policy.
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.musicGain.connect(this.master);
    this.master.connect(this.ctx.destination);
    this._noiseBuf = this._makeNoise(1.0);
    this._applyVolumes();
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const a = this.settings.data.audio;
    this.master.gain.value = a.master;
    this.sfxGain.gain.value = a.sfx;
    this.musicGain.gain.value = a.music;
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _env(node, t0, peak, attack, decay) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _tone({ freq = 440, type = 'square', peak = 0.3, attack = 0.005, decay = 0.12, slideTo = null, dest = null }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + attack + decay);
    osc.connect(g); g.connect(dest || this.sfxGain);
    this._env(g, t0, peak, attack, decay);
    osc.start(t0); osc.stop(t0 + attack + decay + 0.02);
  }

  _noise({ peak = 0.3, attack = 0.002, decay = 0.18, lp = 2000, hp = 200 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const lpf = this.ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = lp;
    const hpf = this.ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hp;
    const g = this.ctx.createGain();
    src.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(this.sfxGain);
    this._env(g, t0, peak, attack, decay);
    src.start(t0); src.stop(t0 + attack + decay + 0.02);
  }

  // ---- named SFX (all original, parameter-driven) ----
  sfx(name) {
    if (!this.ctx) return;
    switch (name) {
      case 'pistol':   this._tone({ freq: 320, type: 'square', peak: 0.35, decay: 0.1, slideTo: 120 }); this._noise({ peak: 0.18, decay: 0.06, lp: 3500 }); break;
      case 'rifle':    this._tone({ freq: 240, type: 'sawtooth', peak: 0.25, decay: 0.06, slideTo: 160 }); this._noise({ peak: 0.12, decay: 0.04, lp: 4000 }); break;
      case 'goocaster':this._tone({ freq: 600, type: 'sine', peak: 0.3, decay: 0.22, slideTo: 90 }); break;
      case 'stinger':  this._tone({ freq: 900, type: 'triangle', peak: 0.22, decay: 0.14, slideTo: 1400 }); break;
      case 'boomstick':this._noise({ peak: 0.45, decay: 0.25, lp: 1800, hp: 80 }); this._tone({ freq: 90, type: 'square', peak: 0.3, decay: 0.18, slideTo: 40 }); break;
      case 'reload':   this._tone({ freq: 180, type: 'square', peak: 0.12, decay: 0.05 }); setTimeout(() => this._tone({ freq: 260, type: 'square', peak: 0.12, decay: 0.06 }), 140); break;
      case 'melee':    this._noise({ peak: 0.3, decay: 0.1, lp: 1200 }); this._tone({ freq: 140, type: 'square', peak: 0.2, decay: 0.1, slideTo: 70 }); break;
      case 'grenade':  this._tone({ freq: 200, type: 'sine', peak: 0.12, decay: 0.1, slideTo: 400 }); break;
      case 'nadetick': this._tone({ freq: 1400, type: 'square', peak: 0.08, decay: 0.03 }); break; // cook beep
      case 'nadebounce':this._noise({ peak: 0.12, decay: 0.06, lp: 900, hp: 100 }); this._tone({ freq: 110, type: 'square', peak: 0.1, decay: 0.05, slideTo: 70 }); break;
      case 'stick':    this._tone({ freq: 500, type: 'sine', peak: 0.18, decay: 0.12, slideTo: 160 }); this._noise({ peak: 0.1, decay: 0.08, lp: 1200 }); break; // goober squelch
      case 'swap':     this._tone({ freq: 220, type: 'square', peak: 0.14, decay: 0.05 }); setTimeout(() => this._tone({ freq: 160, type: 'square', peak: 0.16, decay: 0.07 }), 70); break;
      case 'scopein':  this._tone({ freq: 600, type: 'sine', peak: 0.08, decay: 0.08, slideTo: 950 }); break;
      case 'scopeout': this._tone({ freq: 950, type: 'sine', peak: 0.07, decay: 0.07, slideTo: 600 }); break;
      case 'explosion':this._noise({ peak: 0.6, decay: 0.5, lp: 1400, hp: 40 }); this._tone({ freq: 70, type: 'square', peak: 0.4, decay: 0.4, slideTo: 30 }); break;
      case 'hitmark':  this._tone({ freq: 1200, type: 'square', peak: 0.12, decay: 0.04 }); break;
      case 'pickup':   this._tone({ freq: 700, type: 'sine', peak: 0.2, decay: 0.1, slideTo: 1100 }); break;
      case 'shieldhit':this._tone({ freq: 520, type: 'sine', peak: 0.18, decay: 0.12, slideTo: 300 }); break;
      case 'shieldbreak':this._noise({ peak: 0.3, decay: 0.3, lp: 3000, hp: 600 }); this._tone({ freq: 800, type: 'sine', peak: 0.2, decay: 0.3, slideTo: 200 }); break;
      case 'shieldrecharge':this._tone({ freq: 300, type: 'sine', peak: 0.12, decay: 0.4, slideTo: 700 }); break;
      case 'hurt':     this._tone({ freq: 160, type: 'sawtooth', peak: 0.18, decay: 0.18, slideTo: 90 }); break;
      case 'death':    this._tone({ freq: 220, type: 'sawtooth', peak: 0.3, decay: 0.7, slideTo: 50 }); break;
      case 'blork':    this._tone({ freq: 880, type: 'square', peak: 0.16, decay: 0.12, slideTo: 1500 }); break; // squeaky
      case 'gurg':     this._tone({ freq: 120, type: 'sawtooth', peak: 0.2, decay: 0.2, slideTo: 70 }); break;  // grumble
      case 'wobbler':  this._tone({ freq: 300, type: 'triangle', peak: 0.2, decay: 0.25, slideTo: 220 }); break;
      case 'ui':       this._tone({ freq: 520, type: 'sine', peak: 0.1, decay: 0.05, slideTo: 760 }); break;
      case 'objective':this._tone({ freq: 600, type: 'sine', peak: 0.16, decay: 0.18, slideTo: 900 }); setTimeout(() => this._tone({ freq: 900, type: 'sine', peak: 0.14, decay: 0.2 }), 120); break;
      case 'win':      [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this._tone({ freq: f, type: 'triangle', peak: 0.2, decay: 0.3 }), i * 150)); break;
      case 'lose':     [400, 330, 262, 196].forEach((f, i) => setTimeout(() => this._tone({ freq: f, type: 'sawtooth', peak: 0.2, decay: 0.35 }), i * 180)); break;
      default: break;
    }
  }

  // ---- adaptive music bed ----
  setTrack(track) {
    if (!this.ctx || this._track === track) return;
    this._track = track;
    this._stopMusic();
    if (!track) return;

    const cfg = {
      ambient: { roots: [55, 82.5], type: 'sine', lp: 600, rate: 0.05, peak: 0.5 },
      tension: { roots: [49, 73.42], type: 'triangle', lp: 900, rate: 0.12, peak: 0.6 },
      combat:  { roots: [55, 110, 164.81], type: 'sawtooth', lp: 1400, rate: 0.25, peak: 0.5 },
      finale:  { roots: [41.2, 61.74, 82.4], type: 'sawtooth', lp: 1800, rate: 0.4, peak: 0.6 },
    }[track] || null;
    if (!cfg) return;

    const t0 = this.ctx.currentTime;
    // ramp the new bed IN over half a second — starting at full gain was an audible
    // click, overlapping dissonantly with the old bed's 0.6s fade-out
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(cfg.peak, t0 + 0.5);
    out.connect(this.musicGain);
    const lpf = this.ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = cfg.lp; lpf.Q.value = 6;
    lpf.connect(out);
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = cfg.rate;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = cfg.lp * 0.5;
    lfo.connect(lfoGain); lfoGain.connect(lpf.frequency); lfo.start(t0);
    const oscs = cfg.roots.map((f) => {
      const o = this.ctx.createOscillator(); o.type = cfg.type; o.frequency.value = f;
      const g = this.ctx.createGain(); g.gain.value = 0.3 / cfg.roots.length;
      o.connect(g); g.connect(lpf); o.start(t0); return o;
    });
    this._music = { out, oscs, lfo };
  }

  _stopMusic() {
    if (!this._music) return;
    const t = this.ctx.currentTime;
    try {
      this._music.out.gain.cancelScheduledValues(t);
      this._music.out.gain.setValueAtTime(this._music.out.gain.value, t);
      this._music.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      this._music.oscs.forEach((o) => o.stop(t + 0.7));
      this._music.lfo.stop(t + 0.7);
    } catch (e) { /* already stopped */ }
    this._music = null;
  }

  stopAll() { this._track = null; this._stopMusic(); }
}
