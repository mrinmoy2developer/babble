/**
 * stats.js — tiny persistent global counters (visitors + games played).
 * Stored in data/stats.json so they survive restarts. Writes are debounced.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'stats.json');
let data = { visitors: 0, games: 0 };
try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) { /* first run */ }

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(data));
    } catch (_) { /* best effort */ }
  }, 1000);
}

module.exports = {
  get: () => ({ visitors: data.visitors, games: data.games }),
  addVisitor: () => { data.visitors += 1; save(); },
  addGame: () => { data.games += 1; save(); },
};
