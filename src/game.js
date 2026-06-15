/**
 * game.js — room + round lifecycle for Babble.
 *
 * A Room owns players, settings and the round state machine:
 *   lobby -> (round:start -> collect guesses -> round:reveal) x N -> ended
 *
 * The Room never sends the target phonemes to clients. It sends only the
 * spelling + voice hint so the browser can speak the word aloud; scoring of
 * each guess happens here, on the server, against the hidden phoneme sequence.
 */

'use strict';

const { generateWord, listSources } = require('./words');
const { g2p, score } = require('./phonetics');
const { synthPhonemesB64, listVoices, defaultVoice } = require('./tts');
const { BOT_LEVELS, botGuessPhonemes, phonemesToWord, randomBotAvatar } = require('./bots');

const EARLY_BONUS_MAX = 15; // most extra points a lightning-fast correct guess earns
const MAX_PLAYERS = 12;     // humans + bots

const DEFAULT_SETTINGS = {
  sources: ['gibberish'],
  answerLang: 'en',
  rounds: 5,
  roundSeconds: 45,
  revealSeconds: 30,
  difficulty: 2,
  visibility: 'public', // 'public' (listed in the browser) | 'private' (code only)
  previewWaves: true, // let players see/compare waveforms before submitting
  earlyBonus: false,  // award a small speed bonus, proportional to how early you lock in
  allowBots: false,   // let the host add computer players
  mode: 'normal',     // 'normal' | 'boss' (Boss Baby relay/telephone mode)
  bossAgg: 'mean',    // how the Boss Baby is scored from the others: mean|max|median|trimmed
  maxSubmissions: 1,  // how many guesses a player may submit per round (last one counts)
  voice: '', // piper voice id (resolved to a real default per-room below)
};

const AGG_FNS = ['mean', 'max', 'median', 'trimmed'];

// combine the others' scores into the Boss Baby's score
function aggregate(arr, fn) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  if (fn === 'max') return Math.round(s[s.length - 1]);
  if (fn === 'median') { const m = Math.floor(s.length / 2); return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
  if (fn === 'trimmed') { // truncated mean: drop the top and bottom ~20%
    const k = Math.floor(s.length * 0.2); const t = s.slice(k, s.length - k); const u = t.length ? t : s;
    return Math.round(u.reduce((a, b) => a + b, 0) / u.length);
  }
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length); // mean
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

class Room {
  /** @param {string} code @param {(event:string, payload:any)=>void} emit */
  constructor(code, emit) {
    this.code = code;
    this.emit = emit; // broadcasts to everyone in the room
    this.emitTo = () => {}; // server sets this to emit to one player (boss-mode audio)
    this.players = new Map(); // id -> { id, name, score, connected, isHost }
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS, voice: defaultVoice() };
    this.state = 'lobby';
    this.round = 0;
    this.word = null; // { phonemes, spelling, voice, source }
    this.guesses = new Map(); // playerId -> { text, submittedAt }
    this.phase = 'guess'; // 'guess' (normal) | 'listen' | 'relay' (boss mode)
    this.bossId = null;   // current Boss Baby (boss mode)
    this.relayPhonemes = null; this.relayAudio = ''; // the Boss Baby's babble
    this._submitCounts = new Map(); // playerId -> submissions this round (for the k cap)
    this.deadline = 0;
    this.paused = false;
    this._remaining = 0; // ms left on the round clock while paused
    this._timer = null;
    this._botTimers = []; // pending bot-submission timeouts for this round
    this._botSeq = 0;     // counter for unique bot ids
    this.kickVotes = new Map(); // targetId -> Set(voterId)
    this.createdAt = Date.now();
  }

  // --- players -------------------------------------------------------------
  addPlayer(id, name, avatar, pid) {
    const clean = (name || 'Player').toString().slice(0, 20).trim() || 'Player';
    const isHost = this.players.size === 0;
    if (isHost) this.hostId = id;
    this.players.set(id, {
      id, name: clean, avatar: cleanAvatar(avatar), pid: cleanPid(pid), score: 0, connected: true, isHost,
    });
    return this.players.get(id);
  }

  setAvatar(id, avatar) {
    const p = this.players.get(id);
    if (p) p.avatar = cleanAvatar(avatar) || p.avatar;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this._clearVotesFor(id); // drop their votes + any votes against them
    // reassign host if needed — always to a human, never a bot
    if (this.hostId === id) {
      const next = [...this.players.values()].find((q) => !q.isBot) || null;
      this.hostId = next ? next.id : null;
      if (next) next.isHost = true;
    }
  }

  hasHumans() {
    return [...this.players.values()].some((p) => !p.isBot);
  }

  setName(id, name) {
    const p = this.players.get(id);
    if (p) p.name = (name || p.name).toString().slice(0, 20).trim() || p.name;
  }

  isEmpty() {
    return this.players.size === 0;
  }

  // --- bots ----------------------------------------------------------------
  addBot(levelKey) {
    if (this.state !== 'lobby' || !this.settings.allowBots) return null;
    if (this.players.size >= MAX_PLAYERS) return null;
    const lvl = BOT_LEVELS.find((l) => l.key === levelKey) || BOT_LEVELS[0];
    this._botSeq += 1;
    const id = `bot:${this._botSeq}`;
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = taken.has(lvl.name) ? `${lvl.name} ${this._botSeq}` : lvl.name;
    this.players.set(id, {
      id, name, avatar: cleanAvatar(randomBotAvatar()), pid: null, score: 0, connected: true,
      isHost: false, isBot: true, skill: lvl.skill, botLevel: lvl.key,
    });
    return id;
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (!p || !p.isBot) return false;
    this.players.delete(id);
    return true;
  }

  _removeAllBots() {
    for (const [id, p] of [...this.players]) if (p.isBot) this.players.delete(id);
  }

  bots() {
    return [...this.players.values()].filter((p) => p.isBot);
  }

  // --- vote kick -----------------------------------------------------------
  voteKick(voterId, targetId) {
    const voter = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !target || voterId === targetId || target.isBot || voter.isBot) return null;
    let set = this.kickVotes.get(targetId);
    if (!set) { set = new Set(); this.kickVotes.set(targetId, set); }
    set.add(voterId);
    // a majority of the other present humans is needed
    const eligible = [...this.players.values()].filter((p) => p.connected && !p.isBot && p.id !== targetId).length;
    const needed = Math.floor(eligible / 2) + 1;
    const votes = set.size;
    if (votes >= needed) { this.kickVotes.delete(targetId); return { kicked: true, targetId, name: target.name, votes, needed }; }
    return { kicked: false, targetId, name: target.name, votes, needed };
  }

  _clearVotesFor(id) {
    this.kickVotes.delete(id);
    for (const set of this.kickVotes.values()) set.delete(id);
  }

  // --- settings ------------------------------------------------------------
  updateSettings(id, patch) {
    if (id !== this.hostId || this.state !== 'lobby') return false;
    const s = this.settings;
    if (Array.isArray(patch.sources) && patch.sources.length) s.sources = patch.sources;
    if (typeof patch.answerLang === 'string') s.answerLang = patch.answerLang;
    if (Number.isFinite(patch.rounds)) s.rounds = clamp(patch.rounds, 1, 20);
    if (Number.isFinite(patch.roundSeconds)) s.roundSeconds = clamp(patch.roundSeconds, 10, 180);
    if (Number.isFinite(patch.revealSeconds)) s.revealSeconds = clamp(patch.revealSeconds, 5, 60);
    if (Number.isFinite(patch.difficulty)) s.difficulty = clamp(patch.difficulty, 1, 5);
    if (patch.visibility === 'public' || patch.visibility === 'private') s.visibility = patch.visibility;
    if (typeof patch.previewWaves === 'boolean') s.previewWaves = patch.previewWaves;
    if (typeof patch.earlyBonus === 'boolean') s.earlyBonus = patch.earlyBonus;
    if (typeof patch.allowBots === 'boolean') {
      s.allowBots = patch.allowBots;
      if (!patch.allowBots) this._removeAllBots(); // turning it off clears any bots
    }
    if (patch.mode === 'normal' || patch.mode === 'boss') s.mode = patch.mode;
    if (AGG_FNS.includes(patch.bossAgg)) s.bossAgg = patch.bossAgg;
    if (Number.isFinite(patch.maxSubmissions)) s.maxSubmissions = clamp(patch.maxSubmissions, 1, 5);
    if (typeof patch.voice === 'string') {
      const ids = listVoices().map((v) => v.id);
      if (patch.voice === '' || ids.includes(patch.voice)) s.voice = patch.voice;
    }
    return true;
  }

  // --- round lifecycle -----------------------------------------------------
  start(id) {
    if (id !== this.hostId || this.state === 'playing') return false;
    for (const p of this.players.values()) p.score = 0;
    this.round = 0;
    this._beginRound();
    return true;
  }

  async _beginRound() {
    clearTimeout(this._timer);
    this._clearBotTimers();
    this.round += 1;
    this.state = 'playing';
    this.paused = false;
    this.guesses.clear();
    this._submitCounts = new Map();
    this.relayPhonemes = null; this.relayAudio = '';
    this.word = generateWord({
      sources: this.settings.sources,
      difficulty: this.settings.difficulty,
    });
    // Render the target to audio on the server. Only the audio is sent — never
    // the phonemes — so the answer can't be read off the wire during play.
    this.word.audio = await synthPhonemesB64(this.word.phonemes, { voice: this.settings.voice });
    if (this.state !== 'playing') return; // round was aborted while rendering

    if (this.settings.mode === 'boss') return this._beginBossListen();

    // normal mode: everyone hears the original and guesses it
    this.phase = 'guess';
    this.bossId = null;
    this.deadline = Date.now() + this.settings.roundSeconds * 1000;
    this.emit('round:start', {
      round: this.round,
      totalRounds: this.settings.rounds,
      mode: 'normal',
      phase: 'guess',
      audio: this.word.audio, // base64 WAV, the only way to know the word
      source: this.word.source,
      flag: this.word.flag,
      answerLang: this.settings.answerLang,
      previewWaves: this.settings.previewWaves,
      maxSubmissions: this.settings.maxSubmissions,
      deadline: this.deadline,
      syllables: this.word.syllables,
    });
    this._scheduleBots();
    this._timer = setTimeout(() => this._reveal(), this.settings.roundSeconds * 1000);
  }

  _playerOrder() {
    return [...this.players.values()].filter((p) => p.connected).map((p) => p.id);
  }

  // Boss Baby — phase 1: the chosen player ALONE hears the original and babbles it.
  _beginBossListen() {
    const order = this._playerOrder();
    if (!order.length) return;
    this.bossId = order[(this.round - 1) % order.length];
    const boss = this.players.get(this.bossId);
    this.phase = 'listen';
    this.deadline = Date.now() + this.settings.roundSeconds * 1000;

    // announce who the Boss Baby is — but never broadcast the original audio
    this.emit('round:start', {
      round: this.round,
      totalRounds: this.settings.rounds,
      mode: 'boss',
      phase: 'listen',
      bossId: this.bossId,
      bossName: boss.name,
      bossAvatar: boss.avatar,
      source: this.word.source,
      flag: this.word.flag,
      answerLang: this.settings.answerLang,
      previewWaves: this.settings.previewWaves,
      maxSubmissions: this.settings.maxSubmissions,
      deadline: this.deadline,
      syllables: this.word.syllables,
      audio: null,
    });
    // only the Boss Baby hears the original
    this.emitTo(this.bossId, 'round:audio', { audio: this.word.audio });

    this._scheduleBots(); // schedules the boss bot to transmit, if the boss is a bot
    this._timer = setTimeout(() => this._beginBossRelay(), this.settings.roundSeconds * 1000);
  }

  // Boss Baby — phase 2: the boss's babble becomes the audio everyone else guesses.
  async _beginBossRelay() {
    if (this.state !== 'playing' || this.phase !== 'listen') return;
    clearTimeout(this._timer);
    this._clearBotTimers();
    this.phase = 'relay';

    const bg = this.guesses.get(this.bossId);
    if (bg && bg.phonemes) this.relayPhonemes = bg.phonemes;       // bot boss (stored phonemes)
    else if (bg && bg.text) this.relayPhonemes = g2p(bg.text, this.settings.answerLang);
    else this.relayPhonemes = this.word.phonemes;                  // boss went silent — fall back
    this.relayAudio = await synthPhonemesB64(this.relayPhonemes, { voice: this.settings.voice });
    if (this.state !== 'playing') return;

    this.deadline = Date.now() + this.settings.roundSeconds * 1000;
    this.emit('round:relay', {
      audio: this.relayAudio,
      bossId: this.bossId,
      bossName: this.players.get(this.bossId).name,
      previewWaves: this.settings.previewWaves,
      maxSubmissions: this.settings.maxSubmissions,
      deadline: this.deadline,
    });
    this._scheduleBots(); // the non-boss bots now guess the relayed babble
    this._timer = setTimeout(() => this._reveal(), this.settings.roundSeconds * 1000);
  }

  // --- bot play ------------------------------------------------------------
  _scheduleBots() {
    this._clearBotTimers();
    let bots = this.bots();
    if (this.settings.mode === 'boss') {
      bots = this.phase === 'listen'
        ? bots.filter((b) => b.id === this.bossId)   // only the boss (if a bot) transmits now
        : bots.filter((b) => b.id !== this.bossId);  // everyone but the boss guesses the relay
    }
    for (const bot of bots) {
      // lock in somewhere in the first 30–85% of the round (sharper bots sooner)
      const frac = 0.3 + Math.random() * 0.55 - (bot.skill - 0.5) * 0.15;
      const delay = Math.max(800, this.settings.roundSeconds * 1000 * Math.max(0.15, Math.min(0.9, frac)));
      this._botTimers.push(setTimeout(() => this._botSubmit(bot.id), delay));
    }
  }

  _botSubmit(id) {
    const bot = this.players.get(id);
    if (!bot || !bot.isBot) return;
    if (this.state !== 'playing' || this.paused) { // mid-render or paused — retry soon
      this._botTimers.push(setTimeout(() => this._botSubmit(id), 1000));
      return;
    }
    const prev = this.guesses.get(id);
    if (prev && prev.final) return;
    // which sound is the bot reproducing? the original (normal / boss-listen) or
    // the relayed babble (boss-relay)?
    let src = this.word.phonemes;
    if (this.settings.mode === 'boss') {
      if (this.phase === 'listen') { if (id !== this.bossId) return; }
      else { if (id === this.bossId) return; src = this.relayPhonemes || this.word.phonemes; }
    }
    const phonemes = botGuessPhonemes(src, bot.skill);
    // store the phonemes so _reveal scores/renders them directly (no g2p step)
    this.guesses.set(id, { text: phonemesToWord(phonemes), phonemes, submittedAt: Date.now(), final: true });
    this._emitTally(id, bot, true, true, !prev);
    this._maybeAdvance();
  }

  _clearBotTimers() {
    this._botTimers.forEach(clearTimeout);
    this._botTimers = [];
  }

  // the set of players expected to finish the current guessing phase
  _cohort() {
    if (this.settings.mode === 'boss') {
      if (this.phase === 'listen') return [this.bossId].filter(Boolean);
      return this._playerOrder().filter((cid) => cid !== this.bossId);
    }
    return this._playerOrder();
  }

  _emitTally(id, player, final, firstFinal, firstLock) {
    const cohort = this._cohort();
    const submitted = cohort.filter((cid) => this.guesses.has(cid)).length;
    const locked = cohort.filter((cid) => { const g = this.guesses.get(cid); return g && g.final; }).length;
    this.emit('guess:locked', {
      id, name: player.name, avatar: player.avatar,
      firstLock: firstLock !== false, final, firstFinal,
      submitted, locked, total: cohort.length,
    });
  }

  // advance the round once the right cohort has all locked in
  _maybeAdvance() {
    if (this.settings.mode === 'boss') {
      if (this.phase === 'listen') {
        const g = this.guesses.get(this.bossId);
        if (g && g.final) this._beginBossRelay();
      } else if (this.phase === 'relay') {
        const others = this._cohort();
        if (others.length && others.every((cid) => { const g = this.guesses.get(cid); return g && g.final; })) this._reveal();
      }
      return;
    }
    const active = this._cohort();
    if (active.length && active.every((cid) => { const g = this.guesses.get(cid); return g && g.final; })) this._reveal();
  }

  // --- pause / resume ------------------------------------------------------
  pause(id) {
    if (id !== this.hostId || this.state !== 'playing' || this.paused) return false;
    clearTimeout(this._timer);
    this.paused = true;
    this._remaining = Math.max(0, this.deadline - Date.now());
    this.emit('game:paused', {});
    return true;
  }

  resume(id) {
    if (id !== this.hostId || this.state !== 'playing' || !this.paused) return false;
    this.paused = false;
    this.deadline = Date.now() + this._remaining;
    this.emit('game:resumed', { deadline: this.deadline });
    this._timer = setTimeout(() => this._reveal(), this._remaining);
    return true;
  }

  // On-demand slower re-render of the current word for the "slower" button.
  async renderCurrentSlow() {
    if (!this.word) return null;
    return synthPhonemesB64(this.word.phonemes, { wpm: 100, voice: this.settings.voice });
  }

  submitGuess(id, text, final) {
    if (this.state !== 'playing' || this.paused) return false;
    const player = this.players.get(id);
    if (!player) return false;
    // boss mode: only the right cohort may submit in each phase
    if (this.settings.mode === 'boss') {
      if (this.phase === 'listen' && id !== this.bossId) return false;
      if (this.phase === 'relay' && id === this.bossId) return false;
    }
    const prev = this.guesses.get(id);
    if (prev && prev.final) return false; // already final this round — no take-backs

    // count this submission against the per-round cap; the k-th (or an explicit
    // lock-in) becomes the final, scored guess.
    const k = this.settings.maxSubmissions || 1;
    const count = (this._submitCounts.get(id) || 0) + 1;
    this._submitCounts.set(id, count);
    const isFinal = !!final || count >= k;
    const firstFinal = isFinal && !(prev && prev.final);
    this.guesses.set(id, { text: (text || '').toString().slice(0, 60), submittedAt: Date.now(), final: isFinal });

    this._emitTally(id, player, isFinal, firstFinal, !prev);
    this._maybeAdvance();
    return true;
  }

  // Host may cut the round short.
  forceReveal(id) {
    if (id === this.hostId && this.state === 'playing') this._reveal();
  }

  // Host clicks "Next round" during the reveal to skip the countdown.
  advance(id) {
    if (id !== this.hostId || this.state !== 'reveal') return false;
    clearTimeout(this._timer);
    this._advanceFromReveal();
    return true;
  }

  _advanceFromReveal() {
    if (this.round >= this.settings.rounds) this._end();
    else this._beginRound();
  }

  async _reveal() {
    clearTimeout(this._timer);
    this._clearBotTimers();
    if (this.state !== 'playing') return;
    this.state = 'reveal';

    const isBossMode = this.settings.mode === 'boss';
    const bossId = isBossMode ? this.bossId : null;
    const target = this.word.phonemes;
    const totalMs = this.settings.roundSeconds * 1000;
    // Every guess is scored against the ORIGINAL — even the others, who only heard
    // the Boss Baby's relayed babble. The Boss Baby's own row records how faithful
    // their transmission was, but their points come from the others (below).
    const results = await Promise.all(
      [...this.players.values()].map(async (p) => {
        const isBoss = p.id === bossId;
        const g = this.guesses.get(p.id);
        const text = g ? g.text : '';
        // bots carry their phonemes directly; humans decode their typed text
        const guessPhonemes = g && g.phonemes ? g.phonemes : g2p(text, this.settings.answerLang);
        const base = text ? score(guessPhonemes, target) : 0;
        // optional speed bonus for guessers — proportional to how early they locked
        // in and how good the guess was (the Boss Baby doesn't get a speed bonus).
        let bonus = 0;
        if (!isBoss && this.settings.earlyBonus && g && text && base > 0) {
          const early = Math.max(0, Math.min(1, (this.deadline - g.submittedAt) / totalMs));
          bonus = Math.round(EARLY_BONUS_MAX * early * (base / 100));
        }
        // Render each guess from the SAME phonemes it was scored on.
        const audio = text ? await synthPhonemesB64(guessPhonemes, { voice: this.settings.voice }) : '';
        return { id: p.id, name: p.name, avatar: p.avatar, isBot: !!p.isBot, isBoss,
          guess: text, phonemes: guessPhonemes, audio, base, bonus, points: 0, total: 0 };
      })
    );

    // assign points: guessers earn base+bonus; the Boss Baby earns an aggregate of
    // how close the others got to the original (rewards a faithful transmission).
    let bossInfo = null;
    if (isBossMode && bossId) {
      const others = results.filter((r) => r.id !== bossId);
      const bossScore = aggregate(others.map((r) => r.base), this.settings.bossAgg);
      for (const r of results) r.points = r.isBoss ? bossScore : r.base + r.bonus;
      const bossRes = results.find((r) => r.isBoss);
      const boss = this.players.get(bossId);
      bossInfo = {
        id: bossId, name: boss ? boss.name : '—', avatar: boss ? boss.avatar : '',
        relayAudio: this.relayAudio, relayPhonemes: this.relayPhonemes,
        guess: bossRes ? bossRes.guess : '', accuracy: bossRes ? bossRes.base : 0,
        score: bossScore, agg: this.settings.bossAgg,
      };
    } else {
      for (const r of results) r.points = r.base + r.bonus;
    }
    for (const r of results) { const p = this.players.get(r.id); if (p) { p.score += r.points; r.total = p.score; } }
    results.sort((a, b) => b.points - a.points);

    this.emit('round:reveal', {
      round: this.round,
      totalRounds: this.settings.rounds,
      mode: this.settings.mode,
      boss: bossInfo,
      target: {
        phonemes: target,
        audio: this.word.audio,
        source: this.word.source,
        flag: this.word.flag,
      },
      results,
      leaderboard: this.leaderboard(),
      nextInSeconds: this.settings.revealSeconds,
      isLast: this.round >= this.settings.rounds,
    });

    // Hand the round's per-player outcome to the server for profile analytics.
    // pid stays server-side (it's never put on the wire to other players).
    if (this.onRoundComplete) {
      this.onRoundComplete({
        sourceKey: this.word.sourceKey,
        sourceLabel: this.word.source,
        flag: this.word.flag,
        rows: results.map((r) => ({
          pid: (this.players.get(r.id) || {}).pid,
          name: r.name, avatar: r.avatar,
          points: r.base, hasGuess: !!r.guess, // record closeness, not the speed bonus
        })),
      });
    }

    this._timer = setTimeout(() => this._advanceFromReveal(), this.settings.revealSeconds * 1000);
  }

  _end() {
    clearTimeout(this._timer);
    this.state = 'ended';
    const board = this.leaderboard();
    this.emit('game:over', { leaderboard: board });
    if (this.onGameEnd) {
      const top = board.length ? board[0].score : 0;
      this.onGameEnd(board.map((e, i) => ({
        pid: (this.players.get(e.id) || {}).pid,
        score: e.score,
        // a "win" only counts with an opponent and a non-zero, sole-top score
        won: i === 0 && e.score > 0 && board.length > 1 && (board[1] ? board[1].score < top : true),
      })));
    }
    this.state = 'lobby'; // ready for a rematch from the lobby
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, isHost: p.isHost, isBot: !!p.isBot, botLevel: p.botLevel || null }))
      .sort((a, b) => b.score - a.score);
  }

  // Snapshot for a (re)joining client.
  publicState() {
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      settings: this.settings,
      round: this.round,
      players: this.leaderboard(),
      sources: listSources(),
      voices: listVoices(),
      botLevels: BOT_LEVELS.map((l) => ({ key: l.key, name: l.name, avatar: l.avatar, label: l.label })),
      paused: this.paused,
      deadline: this.state === 'playing' && !this.paused ? this.deadline : 0,
      // a mid-round joiner plays along — but in boss mode they only get the relayed
      // audio (never the original) and nothing at all during the listen phase.
      current:
        this.state === 'playing'
          ? {
            mode: this.settings.mode,
            phase: this.phase,
            bossId: this.bossId,
            bossName: this.bossId ? (this.players.get(this.bossId) || {}).name : null,
            previewWaves: this.settings.previewWaves,
            source: this.word.source,
            audio: this.settings.mode === 'boss' ? (this.phase === 'relay' ? this.relayAudio : null) : this.word.audio,
          }
          : null,
    };
  }

  // Compact entry for the public-lobby browser.
  summary() {
    const host = this.players.get(this.hostId);
    return {
      code: this.code,
      hostName: host ? host.name : '—',
      players: this.players.size,
      bots: this.bots().length,
      state: this.state,
      round: this.round,
      totalRounds: this.settings.rounds,
      sources: this.settings.sources,
      answerLang: this.settings.answerLang,
    };
  }

  dispose() {
    clearTimeout(this._timer);
    this._clearBotTimers();
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Avatars are "<glyph>|#rrggbb|<dir>|<speed>": an Egyptian hieroglyph in a colour
// that spins (dir c/a, speed 0-100). Older clients may send fewer fields or a
// bare emoji. Keep all of them short and well-formed.
function cleanAvatar(a) {
  if (typeof a !== 'string') return '';
  const parts = a.split('|');
  if (parts.length >= 2 && /^#[0-9a-fA-F]{6}$/.test(parts[1])) {
    const g = /^g\d{1,3}$/.test(parts[0]) ? parts[0] : [...parts[0]].slice(0, 2).join('');
    const dir = parts[2] === 'a' ? 'a' : 'c';
    const speed = parts.length >= 4 ? Math.max(0, Math.min(100, Math.round(Number(parts[3]) || 0))) : 45;
    return `${g}|${parts[1].toLowerCase()}|${dir}|${speed}`;
  }
  return [...a].slice(0, 3).join(''); // legacy emoji
}

// A profile id is an opaque public token the client generates and persists.
function cleanPid(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(p) ? p : null;
}

module.exports = { Room, makeCode, DEFAULT_SETTINGS, aggregate };
