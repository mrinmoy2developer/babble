'use strict';
// Synchronous checks for Room settings, guards, and summaries (no TTS/timers).
const assert = require('assert');
const { Room } = require('../src/game');

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

// tentative submit keeps the round open; only a lock-in counts toward early reveal
const ev2 = [];
const r2 = new Room('T2', (ev, payload) => ev2.push({ ev, payload }));
r2.addPlayer('a', 'A');
r2.state = 'playing'; // simulate an active round without the async _beginRound
r2.deadline = Date.now() + 60000;
ok('tentative submit accepted', r2.submitGuess('a', 'foo', false) === true);
const lastLock = ev2[ev2.length - 1];
ok('tentative submit is flagged not-final', lastLock.ev === 'guess:locked' && lastLock.payload.final === false && lastLock.payload.locked === 0);
ok('round stays open after a tentative submit by all', r2.state === 'playing');

// summary shape for the public browser
const sum = room.summary();
ok('summary names the host', sum.hostName === 'Ada');
ok('summary counts players', sum.players === 2);
ok('summary reports lobby state', sum.state === 'lobby');

// host reassignment on leave
room.removePlayer('h');
ok('host reassigned when host leaves', room.hostId === 'g' && room.players.get('g').isHost);

console.log(`\n${passed} checks passed.`);
