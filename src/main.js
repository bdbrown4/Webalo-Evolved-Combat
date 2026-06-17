// main.js — boot + top-level wiring. Creates the subsystems, connects the Game
// state machine to the Menus, runs the render loop, and routes the pause key.

import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Audio } from './core/Audio.js';
import { Game } from './core/Game.js';
import { Menus } from './ui/Menus.js';

const canvas = document.getElementById('game-canvas');
const root = document.getElementById('ui-root');

// Kill mobile zoom entirely — this is a game, not a document. iOS Safari ignores
// `user-scalable=no`, so we also swallow its pinch (gesture*) events and any
// stray multi-touch zoom. (`touch-action: manipulation` in CSS handles
// double-tap zoom; menus keep their own vertical scrolling.)
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

// iOS Safari still double-tap-zooms on some versions even with touch-action:none,
// and a rapid fire-tap reads to the OS exactly like a double-tap. Cancel the
// second tap of any quick pair that lands on a GAME surface (the canvas or the
// touch overlay). Our own fire/reload run on pointer events, which this never
// touches — and menus, which need ordinary tapping, are left completely alone.
let _lastGameTap = 0;
const onGameSurface = (t) => !!(t && (t.id === 'game-canvas' || (t.closest && t.closest('.touch-controls'))));
document.addEventListener('touchend', (e) => {
  if (!onGameSurface(e.target)) return;
  const now = e.timeStamp || performance.now();
  if (now - _lastGameTap < 350) e.preventDefault(); // swallow the zoom-triggering second tap
  _lastGameTap = now;
}, { passive: false });

const settings = new Settings();
const audio = new Audio(settings);
const input = new Input(canvas, settings);
const game = new Game(canvas, root, settings, input, audio);

const menus = new Menus(root, settings, input, audio, {
  onStart: (index) => { menus.hide(); game.startMission(index); },
  onTutorial: () => { menus.hide(); game.startTutorial(); },
  onSurvival: () => { menus.hide(); game.startSurvival(); },
  onCoopHost: () => { menus.hide(); game.coopHost(); },
  onCoopJoin: (code) => { menus.hide(); game.coopJoin(code); },
  onCoopHostManual: () => { menus.hide(); game.coopHostManual(); },
  onCoopJoinManual: () => { menus.hide(); game.coopJoinManual(); },
  onResume: () => { game.resume(); },
  onRestart: () => { menus.hide(); game.restartFresh(); },
  onQuit: () => { game.quitToMenu(); },
});

// Game -> Menus bridges
game.onPause = () => menus.showPause();
game.onResume = () => menus.hide();
game.onQuit = () => menus.showMain();
game.onShowSelect = () => menus.showMissionSelect();

// Pause key (works regardless of input-enabled state; respects rebinding capture)
window.addEventListener('keydown', (e) => {
  if (input._rebindResolver) return; // a settings rebind is capturing this key
  // Escape is ALWAYS a valid pause/menu key, in addition to the rebindable one,
  // so the player can never be locked out of the menu by reassigning Pause.
  const isPauseKey = e.code === settings.bindings.pause || e.code === 'Escape';
  if (!isPauseKey) return;
  if (game.state === 'playing') { e.preventDefault(); game.togglePause(); }
  else if (game.state === 'paused' && menus.screen === 'pause') { e.preventDefault(); game.togglePause(); }
});

// Render loop
function frame() {
  game.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Start at the main menu
menus.showMain();

// Expose for debugging in the console (dev only; Vite tree-shakes this out of
// the production build so internals aren't shipped on a global).
if (import.meta.env && import.meta.env.DEV) {
  window.__webalo = { game, settings, input, audio, menus };
}
