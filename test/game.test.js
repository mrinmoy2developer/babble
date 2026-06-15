'use strict';
// Synchronous checks for Room settings, guards, and summaries (no TTS/timers).
const assert = require('assert');
const { Room, aggregate } = require('../src/game');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

console.log('game:');

const events = [];
const room = new Room('TEST', (ev, payload) => events.push({ ev, payload }));
const host = room.addPlayer('h', 'Ada');
const guest = room.addPlayer('g', 'Bjarne');

ok('first player becomes host', host.isHost && room.hostId === 'h');
ok('second player is not host', !guest.isHost);

// settings: host only, in lobby
ok('non-host cannot change settings', room.updateSettings('g', { rounds: 9 }) === false);
ok('host can change settings', room.updateSettings('h', { rounds: 9 }) === true && room.settings.rounds === 9);

// new settings + clamps
room.updateSettings('h', { visibility: 'private', previewWaves: false, revealSeconds: 999 });
ok('visibility set', room.settings.visibility === 'private');
ok('previewWaves toggled off', room.settings.previewWaves === false);
ok('revealSeconds clamped to <= 60', room.settings.revealSeconds === 60);
ok('bad visibility ignored', room.updateSettings('h', { visibility: 'weird' }) && room.settings.visibility === 'private');

// guards outside the right state
ok('pause refused outside playing', room.pause('h') === false);
ok('resume refused when not paused', room.resume('h') === false);
ok('advance refused outside reveal', room.advance('h') === false);
ok('submitGuess refused outside playing', room.submitGuess('h', 'x') === false);

// k-submissions: with maxSubmissions=2 the first guess is a draft, the 2nd is final
const ev2 = [];
const r2 = new Room('T2', (ev, payload) => ev2.push({ ev, payload }));
r2.addPlayer('a', 'A'); r2.addPlayer('b', 'B'); // 'a' is host; 'b' keeps the round open
r2.updateSettings('a', { maxSubmissions: 2 });
r2.state = 'playing'; // simulate an active round without the async _beginRound
r2.deadline = Date.now() + 60000;
ok('first submit (of k=2) accepted as a draft', r2.submitGuess('a', 'foo', false) === true);
let lastLock = ev2[ev2.length - 1];
ok('first submit is not yet final', lastLock.ev === 'guess:locked' && lastLock.payload.final === false);
ok('round stays open after a draft', r2.state === 'playing');
ok('second submit accepted', r2.submitGuess('a', 'bar', false) === true);
lastLock = ev2[ev2.length - 1];
ok('the k-th submit becomes final', lastLock.payload.final === true);
ok('a third submit is rejected once final', r2.submitGuess('a', 'baz', false) === false);

// Boss Baby aggregation functions
ok('mean aggregate', aggregate([10, 20, 30], 'mean') === 20);
ok('max aggregate', aggregate([10, 20, 30], 'max') === 30);
ok('median aggregate (odd)', aggregate([10, 20, 90], 'median') === 20);
ok('median aggregate (even)', aggregate([10, 20, 30, 40], 'median') === 25);
ok('trimmed mean drops the extremes', aggregate([0, 20, 30, 40, 100], 'trimmed') === 30);
ok('empty aggregate is 0', aggregate([], 'mean') === 0);

// boss-mode settings validate
const r3 = new Room('T3', () => {});
r3.addPlayer('h', 'Ada');
ok('mode accepts boss', r3.updateSettings('h', { mode: 'boss' }) && r3.settings.mode === 'boss');
ok('bad mode ignored', r3.updateSettings('h', { mode: 'weird' }) && r3.settings.mode === 'boss');
ok('bossAgg accepts median', r3.updateSettings('h', { bossAgg: 'median' }) && r3.settings.bossAgg === 'median');
ok('maxSubmissions clamped to <= 5', r3.updateSettings('h', { maxSubmissions: 99 }) && r3.settings.maxSubmissions === 5);

// summary shape for the public browser
const sum = room.summary();
ok('summary names the host', sum.hostName === 'Ada');
ok('summary counts players', sum.players === 2);
ok('summary reports lobby state', sum.state === 'lobby');

// host reassignment on leave
room.removePlayer('h');
ok('host reassigned when host leaves', room.hostId === 'g' && room.players.get('g').isHost);

console.log(`\n${passed} checks passed.`);
