/**
 * profiles.js — persistent, public per-player analytics for Babble.
 *
 * There are no accounts: a player carries a random `pid` in localStorage, sends
 * it when joining, and the server aggregates their results here. Everything is
 * public (anyone can browse any profile), so a pid is just an opaque public key
 * — nothing secret lives behind it. Stored in data/profiles.json; writes are
 * debounced. We keep rolling aggregates (never the full history) so the file
 * stays small no matter how long someone plays.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'profiles.json');
const MAX_PROFILES = 5000; // evict least-recently-seen beyond this
const RECENT_CAP = 60;     // rounds kept for the score-over-time chart
const BUCKETS = 11;        // closeness histogram: 0-9,10-19,…,90-99,100

let data = { profiles: {} };
try { data = { profiles: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) { /* first run */ }

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(data));
    } catch (_) { /* best effort */ }
  }, 1200);
}

const cleanId = (id) => (typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null);
const cleanStr = (s, n) => (s == null ? '' : String(s)).slice(0, n);
const clampPts = (p) => Math.max(0, Math.min(100, Math.round(p || 0)));

function blank(id) {
  return {
    id, name: 'Player', avatar: '',
    games: 0, wins: 0, rounds: 0, scoreSum: 0, best: 0, bestGame: 0,
    hist: new Array(BUCKETS).fill(0), // closeness distribution
    langs: {},                        // sourceKey -> { label, flag, rounds, sum, best }
    recent: [],                       // [{ points, key, flag, ts }] capped
    firstSeen: Date.now(), lastSeen: Date.now(),
  };
}

function ensure(id) {
  let p = data.profiles[id];
  if (!p) { p = data.profiles[id] = blank(id); evictIfNeeded(); }
  if (!Array.isArray(p.hist) || p.hist.length !== BUCKETS) p.hist = new Array(BUCKETS).fill(0);
  if (!p.langs) p.langs = {};
  if (!Array.isArray(p.recent)) p.recent = [];
  return p;
}

function evictIfNeeded() {
  const ids = Object.keys(data.profiles);
  if (ids.length <= MAX_PROFILES) return;
  ids.sort((a, b) => (data.profiles[a].lastSeen || 0) - (data.profiles[b].lastSeen || 0));
  for (let i = 0; i < ids.length - MAX_PROFILES; i++) delete data.profiles[ids[i]];
}

/** Record one scored guess for a player. */
function recordRound(id, { name, avatar, points, sourceKey, sourceLabel, flag } = {}) {
  id = cleanId(id); if (id == null) return;
  const p = ensure(id);
  if (name) p.name = cleanStr(name, 20);
  if (avatar) p.avatar = cleanStr(avatar, 8);
  const pts = clampPts(points);
  p.rounds += 1; p.scoreSum += pts;
  if (pts > p.best) p.best = pts;
  p.hist[Math.min(BUCKETS - 1, Math.floor(pts / 10))] += 1;

  const key = cleanStr(sourceKey || 'unknown', 40);
  const lang = p.langs[key] || (p.langs[key] = { label: '', flag: '', rounds: 0, sum: 0, best: 0 });
  lang.label = cleanStr(sourceLabel || lang.label || key, 40);
  lang.flag = cleanStr(flag || lang.flag || 'dice', 8);
  lang.rounds += 1; lang.sum += pts; if (pts > lang.best) lang.best = pts;

  p.recent.push({ points: pts, key, flag: lang.flag, ts: Date.now() });
  if (p.recent.length > RECENT_CAP) p.recent.shift();
  p.lastSeen = Date.now();
  save();
}

/** Record a finished game (called once per player when a game ends). */
function recordGame(id, { finalScore, won } = {}) {
  id = cleanId(id); if (id == null) return;
  const p = ensure(id);
  p.games += 1;
  if (won) p.wins += 1;
  const fin = Math.max(0, Math.round(finalScore || 0));
  if (fin > p.bestGame) p.bestGame = fin;
  p.lastSeen = Date.now();
  save();
}

function summary(p) {
  return {
    id: p.id, name: p.name, avatar: p.avatar,
    games: p.games, wins: p.wins, rounds: p.rounds,
    avg: p.rounds ? Math.round(p.scoreSum / p.rounds) : 0,
    best: p.best, bestGame: p.bestGame, lastSeen: p.lastSeen,
  };
}

/** Public directory (optionally filtered by a name query). */
function list(q) {
  let arr = Object.values(data.profiles).filter((p) => p.rounds > 0 || p.games > 0);
  if (q) { const s = String(q).toLowerCase(); arr = arr.filter((p) => (p.name || '').toLowerCase().includes(s)); }
  arr.sort((a, b) => (b.rounds + b.games * 3) - (a.rounds + a.games * 3) || b.best - a.best);
  return arr.slice(0, 60).map(summary);
}

/** Full analytics payload for one profile, or null. */
function get(id) {
  id = cleanId(id); if (id == null) return null;
  const p = data.profiles[id]; if (!p) return null;
  const langs = Object.keys(p.langs).map((k) => {
    const l = p.langs[k];
    return { key: k, label: l.label || k, flag: l.flag || 'dice', rounds: l.rounds, avg: l.rounds ? Math.round(l.sum / l.rounds) : 0, best: l.best };
  }).sort((a, b) => b.rounds - a.rounds);
  return { ...summary(p), firstSeen: p.firstSeen, hist: p.hist.slice(), langs, recent: p.recent.slice(-RECENT_CAP) };
}

module.exports = { recordRound, recordGame, get, list, _FILE: FILE };
