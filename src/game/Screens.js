// Screens.js — Game methods for the full-screen moments between play: the
// mission card, mission complete/failed, the solo result (with perk picks),
// and the Daily Challenge result with its share code. Mixed into Game.prototype.

import { CAMPAIGN, markCompleted, clearCheckpoint, loadProgress, saveProgress } from '../missions/campaign.js';
import { PERKS, PERK_IDS, applyPerk } from '../core/Perks.js';
import { getDifficulty, DIFFICULTY_ORDER } from '../core/Difficulty.js';
import { serializeSnapshot } from '../net/CoopSync.js';

export const ScreensMixin = {
  _showMissionCard(mission) {
    this._clearResult();
    this.card = document.createElement('div');
    this.card.className = 'interactive';
    this.card.innerHTML = `
      <div class="screen">
        <div class="mission-card">
          <div class="mission-num">Mission ${this.missionIndex + 1} of ${CAMPAIGN.length}</div>
          <div class="mission-name">${mission.name}</div>
          <div class="mission-brief">${mission.brief}</div>
          ${this._runPerks.length ? `<div class="mission-perks">◆ Upgrades: ${this._runPerks.map((id) => (PERKS[id] ? PERKS[id].name : id)).join(' · ')}</div>` : ''}
          <div style="margin-bottom:20px"><span style="color:var(--ink-dim);letter-spacing:1px">DIFFICULTY:</span>
            <button class="btn ghost" data-act="diff" style="display:inline-block;padding:7px 16px;margin-left:8px">${getDifficulty(this.settings.data.difficulty).name}</button></div>
          <button class="btn primary" style="display:inline-block" data-act="go">▶ Begin Mission</button>
        </div>
      </div>`;
    this.root.appendChild(this.card);
    this.card.querySelector('[data-act="go"]').addEventListener('click', () => {
      this.audio.ensure(); this.audio.sfx('ui');
      this._beginMission(mission);
    });
    const diffBtn = this.card.querySelector('[data-act="diff"]');
    if (diffBtn) diffBtn.addEventListener('click', () => {
      this.audio.ensure(); this.audio.sfx('ui');
      const cur = DIFFICULTY_ORDER.indexOf(this.settings.data.difficulty);
      const next = DIFFICULTY_ORDER[(cur + 1) % DIFFICULTY_ORDER.length];
      this.settings.set('difficulty', next);
      diffBtn.textContent = getDifficulty(next).name;
    });
  },

  // ---------- results ----------
  _missionComplete() {
    if (this.state === 'result') return;
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.hud.clearTransients();
    // drop a held grenade hand / mid-jab fist and restore the weapon so none
    // freeze on screen under the result banner (death/win can land mid-action)
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = !this.player.driving;
    this.audio.sfx('win');
    const m = CAMPAIGN[this.missionIndex];
    const isFinaleDone = this.missionIndex >= CAMPAIGN.length - 1;
    // co-op host: don't touch solo save progress; tell the guest, then show the
    // shared mission-complete screen (each side picks its own upgrade).
    if (this.coopRole === 'host') {
      this._coopOver = true;
      this._netPush('mcomplete', isFinaleDone ? 1 : 0);
      if (this.net) this.net.send('snap', serializeSnapshot(this));   // flush so the guest gets it now
      this.hud.banner('MISSION COMPLETE', m.outro, 3);
      setTimeout(() => { if (this.coopRole === 'host') this._showCoopResult(isFinaleDone); }, 2600);
      return;
    }
    // Daily Mission: a one-shot scored run (completion + kills + speed) — its own
    // result screen, no campaign save/perks/advance.
    if (this._daily) {
      const secs = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._dailyStart) / 1000;
      const score = 5000 + this._dailyKills * 10 + Math.max(0, Math.round(1800 - secs * 6));
      this._recordDaily(score);
      this.hud.banner('MISSION COMPLETE', m.outro, 3);
      setTimeout(() => this._showDailyResult(true), 2600);
      return;
    }
    markCompleted(this.missionIndex);
    clearCheckpoint(this.missionIndex);
    this.hud.banner('MISSION COMPLETE', m.outro, 3);
    setTimeout(() => this._showResult(true, isFinaleDone), 2600);
  },

  _missionFailed(reason) {
    if (this.state === 'result') return;
    // co-op host: an objective/escape failure ends the run for both — shared retry.
    if (this.coopRole === 'host') {
      this._coopOver = true;
      this._setPlayInput(false); this.input.exitLock();
      this.state = 'result'; this.hud.clearTransients();
      this._clearNadeModel(); this._clearMeleeModel();
      if (this._viewModel) this._viewModel.visible = !this.player.driving;
      this.audio.sfx('lose');
      this._netPush('coopfail');
      if (this.net) this.net.send('snap', serializeSnapshot(this));
      this.hud.banner('MISSION FAILED', reason || 'You fell on the Aureole.', 2.5);
      setTimeout(() => { if (this.coopRole === 'host') this._showCoopFail(true); }, 2200);
      return;
    }
    this.state = 'result';
    this._setPlayInput(false); this.input.exitLock();
    this.hud.clearTransients();
    this._clearNadeModel();
    this._clearMeleeModel();
    if (this._viewModel) this._viewModel.visible = !this.player.driving;
    this.audio.sfx('lose');
    // Daily Mission failure still scores kills (partial credit), then its own screen
    if (this._daily) {
      this._recordDaily(this._dailyKills * 10);
      this.hud.banner('DOWN', reason || 'You fell on the Aureole.', 2.5);
      setTimeout(() => this._showDailyResult(false), 2200);
      return;
    }
    this.hud.banner('DOWN', reason || 'You fell on the Aureole.', 2.5);
    setTimeout(() => this._showResult(false, false), 2200);
  },

  // Daily run result (mission win/lose, or routed here from Survival's game-over).
  // Shows the score, today's best, and a copyable share code; Retry replays the
  // exact same daily; otherwise back to the menu.
  _showDailyResult(win) {
    this.hud.show(false);
    this._clearResult();
    const r = this._lastDaily || { score: 0, best: 0, code: '' };
    const isMission = this._daily && this._daily.mode === 'mission';
    const beat = r.best <= r.score;
    this.result = document.createElement('div');
    this.result.className = 'interactive';
    this.result.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title" style="font-size:48px">${isMission ? (win ? 'Daily Mission Cleared' : 'Daily Mission — Down') : 'Daily Survival'}</div>
          <div class="game-tag">Score <b>${r.score}</b> · Today's best <b>${r.best}</b>${beat && r.score > 0 ? ' &nbsp;★ new best!' : ''}</div>
        </div>
        <div class="daily-share">
          <div class="daily-share-label">Share your result — paste it to a friend to challenge today's seed:</div>
          <div class="daily-code-row"><code class="daily-code">${r.code}</code><button class="btn" data-act="copy">⧉ Copy</button></div>
        </div>
        <div class="menu-list">
          <button class="btn primary" data-act="retry">↻ Replay Today's Daily</button>
          <button class="btn" data-act="menu">⏏ Main Menu</button>
        </div>
      </div>`;
    this.root.appendChild(this.result);
    const copyBtn = this.result.querySelector('[data-act="copy"]');
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(r.code); copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1200); } catch (e) {} });
    this.result.querySelector('[data-act="retry"]').addEventListener('click', () => { this.audio.sfx('ui'); this._clearResult(); this._replayDaily(); });
    this.result.querySelector('[data-act="menu"]').addEventListener('click', () => { this.audio.sfx('ui'); this._clearResult(); this.quitToMenu(); });
  },

  // ---------- between-mission perks ----------
  _applyPerks(player) {
    for (const id of this._runPerks) applyPerk(player, id);
    player.shield = player.shieldMax;          // start the mission topped up to the perked maxes
    player.health = player.healthMax;
    if (player.grenadeBonus) { player.grenades.frag += player.grenadeBonus; player.grenades.goober += player.grenadeBonus; }
  },

  _saveRunPerks() { const p = loadProgress(); p.perks = this._runPerks.slice(); saveProgress(p); },

  _choosePerk(id) {
    if (id && PERKS[id] && !this._runPerks.includes(id)) { this._runPerks.push(id); this._saveRunPerks(); }
    this.startMission(this.missionIndex + 1);
  },

  _showResult(win, finaleDone) {
    this.hud.show(false);
    this._clearResult();
    this.result = document.createElement('div');
    this.result.className = 'interactive';
    const next = this.missionIndex + 1 < CAMPAIGN.length;
    // a non-finale win offers a perk pick — 3 drawn from the unowned pool
    const perkPick = win && next && !finaleDone;
    const choices = perkPick ? PERK_IDS.filter((id) => !this._runPerks.includes(id)).sort(() => Math.random() - 0.5).slice(0, 3) : [];
    const perkSection = choices.length
      ? `<div class="perk-pick"><div class="perk-pick-head">◆ Choose an upgrade</div><div class="perk-cards">${
        choices.map((id) => `<button class="perk-card" data-perk="${id}"><b>${PERKS[id].name}</b><span>${PERKS[id].desc}</span></button>`).join('')
      }</div></div>` : '';
    this.result.innerHTML = `
      <div class="screen">
        <div class="title-block">
          <div class="game-title" style="font-size:54px">${finaleDone ? 'The Halo Goes Dark' : win ? 'Mission Complete' : 'You Are Down'}</div>
          <div class="game-tag">${finaleDone ? 'Sgt. Orion rides the wreckage out. The Aureole is silent. Roll credits.' : win ? CAMPAIGN[this.missionIndex].outro : 'The Wobble Coalition will be insufferable about this.'}</div>
        </div>
        ${perkSection}
        <div class="menu-list">
          ${perkPick && !choices.length ? '<button class="btn primary" data-act="next">▶ Next Mission</button>' : ''}
          ${!win ? '<button class="btn primary" data-act="retry">↻ Retry Mission</button>' : ''}
          ${finaleDone ? '<button class="btn primary" data-act="menu">★ Finish</button>' : '<button class="btn" data-act="menu">⏏ Mission Select</button>'}
        </div>
      </div>`;
    this.root.appendChild(this.result);
    const handler = (a) => { this.audio.sfx('ui'); if (a === 'next') this.startMission(this.missionIndex + 1); else if (a === 'retry') this.restartCheckpoint(); else { this._clearResult(); this.quitToMenu(); this.onShowSelect && this.onShowSelect(); } };
    this.result.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => handler(b.dataset.act)));
    this.result.querySelectorAll('[data-perk]').forEach((b) => b.addEventListener('click', () => { this.audio.sfx('objective'); this._choosePerk(b.dataset.perk); }));
  },

  _clearResult() { if (this.result) { this.result.remove(); this.result = null; } if (this.card) { this.card.remove(); this.card = null; } },
};
