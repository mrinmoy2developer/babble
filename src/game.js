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

const DEFAULT_SETTINGS = {
  sources: ['gibberish'],
  answerLang: 'en',
  rounds: 5,
  roundSeconds: 45,
  revealSeconds: 30,
  difficulty: 2,
  visibility: 'public', // 'public' (listed in the browser) | 'private' (code only)
  previewWaves: true, // let players see/compare waveforms before submitting
  voice: '', // piper voice id (resolved to a real default per-room below)
};

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
    this.players = new Map(); // id -> { id, name, score, connected, isHost }
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS, voice: defaultVoice() };
    this.state = 'lobby';
    this.round = 0;
    this.word = null; // { phonemes, spelling, voice, source }
    this.guesses = new Map(); // playerId -> { text, submittedAt }
    this.deadline = 0;
    this.paused = false;
    this._remaining = 0; // ms left on the round clock while paused
    this._timer = null;
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
    // reassign host if needed
    if (this.hostId === id) {
      const next = [...this.players.values()][0];
      this.hostId = next ? next.id : null;
      if (next) next.isHost = true;
    }
  }

  setName(id, name) {
    const p = this.players.get(id);
    if (p) p.name = (name || p.name).toString().slice(0, 20).trim() || p.name;
  }

  isEmpty() {
    return this.players.size === 0;
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
    this.round += 1;
    this.state = 'playing';
    this.paused = false;
    this.guesses.clear();
    this.word = generateWord({
      sources: this.settings.sources,
      difficulty: this.settings.difficulty,
    });
    // Render the target to audio on the server. Only the audio is sent — never
    // the phonemes — so the answer can't be read off the wire during play.
    this.word.audio = await synthPhonemesB64(this.word.phonemes, { voice: this.settings.voice });
    if (this.state !== 'playing') return; // round was aborted while rendering

    this.deadline = Date.now() + this.settings.roundSeconds * 1000;

    this.emit('round:start', {
      round: this.round,
      totalRounds: this.settings.rounds,
      audio: this.word.audio, // base64 WAV, the only way to know the word
      source: this.word.source,
      flag: this.word.flag,
      answerLang: this.settings.answerLang,
      previewWaves: this.settings.previewWaves,
      deadline: this.deadline,
      syllables: this.word.syllables,
    });

    this._timer = setTimeout(() => this._reveal(), this.settings.roundSeconds * 1000);
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
    final = !!final;
    const prev = this.guesses.get(id);
    const firstLock = !prev; // first time this player submits anything this round
    const firstFinal = final && !(prev && prev.final); // first time they lock it in
    this.guesses.set(id, { text: (text || '').toString().slice(0, 60), submittedAt: Date.now(), final });

    const locked = [...this.guesses.values()].filter((g) => g.final).length;
    // Broadcast the tally only — never the guess text. A tentative "draft" submit
    // keeps the answer editable; a final "lock in" is what can end the round early.
    this.emit('guess:locked', {
      id,
      name: player.name,
      avatar: player.avatar,
      firstLock,
      final,
      firstFinal,
      submitted: this.guesses.size,
      locked,
      total: this.players.size,
    });

    // End early only once every present player has LOCKED IN (not just drafted),
    // so a tentative submit never robs anyone of the chance to change their mind.
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.length && active.every((p) => { const g = this.guesses.get(p.id); return g && g.final; })) {
      this._reveal();
    }
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
    if (this.state !== 'playing') return;
    this.state = 'reveal';

    const target = this.word.phonemes;
    const results = await Promise.all(
      [...this.players.values()].map(async (p) => {
        const g = this.guesses.get(p.id);
        const text = g ? g.text : '';
        const guessPhonemes = g2p(text, this.settings.answerLang);
        const points = text ? score(guessPhonemes, target) : 0;
        p.score += points;
        // Render each guess from the SAME phonemes it was scored on, so the
        // audio you hear is exactly what the comparison judged.
        const audio = text ? await synthPhonemesB64(guessPhonemes, { voice: this.settings.voice }) : '';
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          guess: text,
          phonemes: guessPhonemes,
          audio,
          points,
          total: p.score,
        };
      })
    );
    results.sort((a, b) => b.points - a.points);

    this.emit('round:reveal', {
      round: this.round,
      totalRounds: this.settings.rounds,
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
          points: r.points, hasGuess: !!r.guess,
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
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, isHost: p.isHost }))
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
      paused: this.paused,
      deadline: this.state === 'playing' && !this.paused ? this.deadline : 0,
      // a mid-round joiner gets the current word's audio so they can play along
      current:
        this.state === 'playing'
          ? { audio: this.word.audio, source: this.word.source, previewWaves: this.settings.previewWaves }
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
      state: this.state,
      round: this.round,
      totalRounds: this.settings.rounds,
      sources: this.settings.sources,
      answerLang: this.settings.answerLang,
    };
  }

  dispose() {
    clearTimeout(this._timer);
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Avatars are a single emoji chosen client-side; keep it short and harmless.
function cleanAvatar(a) {
  return typeof a === 'string' ? [...a].slice(0, 3).join('') : '';
}

// A profile id is an opaque public token the client generates and persists.
function cleanPid(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(p) ? p : null;
}

module.exports = { Room, makeCode, DEFAULT_SETTINGS };
