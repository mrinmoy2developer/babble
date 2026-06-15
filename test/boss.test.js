'use strict';
// End-to-end Boss Baby mode: the boss hears the original, relays it, the others
// guess the relay but are scored on the original, and the boss is scored on them.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3097;
const URL = `http://localhost:${PORT}`;
const server = spawn('node', ['server.js'], {
  cwd: require('path').join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 9000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await wait(100); return fn(); };
const conn = () => io(URL, { transports: ['websocket'], forceNew: true });

(async () => {
  await wait(700);
  let failures = 0;
  const assert = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) failures++; };

  const host = conn();
  const guest = conn();
  await new Promise((r) => host.on('connect', r));
  await new Promise((r) => guest.on('connect', r));

  const code = await new Promise((r) => host.emit('room:create', { name: 'Ada', pid: 'p-ada-boss' }, (x) => r(x.code)));
  await new Promise((r) => guest.emit('room:join', { code, name: 'Bo', pid: 'p-bo-boss' }, () => r()));
  host.emit('room:settings', { mode: 'boss', bossAgg: 'mean', rounds: 1, roundSeconds: 6, revealSeconds: 3, sources: ['gibberish'] });
  await wait(150);

  let hostStart = null, hostAudio = null, guestAudio = null, guestRelay = null, reveal = null;
  host.on('round:start', (d) => { hostStart = d; });
  host.on('round:audio', (d) => { hostAudio = d; });
  guest.on('round:audio', (d) => { guestAudio = d; });
  guest.on('round:relay', (d) => { guestRelay = d; });
  host.on('round:reveal', (d) => { reveal = d; });

  host.emit('game:start');
  await waitFor(() => hostStart);
  await waitFor(() => hostAudio);

  assert('round:start is boss mode with a bossId', hostStart && hostStart.mode === 'boss' && !!hostStart.bossId);
  assert('round:start carries NO original audio', hostStart && hostStart.audio == null);
  assert('the Boss Baby is the host (first in order)', hostStart && hostStart.bossId === host.id);
  assert('the boss alone received the original audio', hostAudio && typeof hostAudio.audio === 'string' && hostAudio.audio.length > 100);
  assert('the non-boss did NOT receive the original', !guestAudio);

  host.emit('guess:submit', { text: 'bobo', final: true }); // boss transmits
  await waitFor(() => guestRelay);

  assert('the relayed babble reached the guesser', guestRelay && typeof guestRelay.audio === 'string' && guestRelay.audio.length > 100);

  guest.emit('guess:submit', { text: 'lulu', final: true }); // guesser guesses the relay
  await waitFor(() => reveal);

  assert('round:reveal received', !!reveal);
  assert('reveal is boss mode with boss info', reveal && reveal.mode === 'boss' && reveal.boss && reveal.boss.id === host.id);
  assert('reveal includes the relayed babble audio', reveal && typeof reveal.boss.relayAudio === 'string' && reveal.boss.relayAudio.length > 100);
  assert('exactly one Boss Baby in the results', reveal && reveal.results.filter((r) => r.isBoss).length === 1);
  const bossRow = reveal && reveal.results.find((r) => r.isBoss);
  const others = reveal ? reveal.results.filter((r) => !r.isBoss) : [];
  const expected = others.length ? Math.round(others.reduce((a, r) => a + r.base, 0) / others.length) : 0;
  assert('boss score = mean of the others’ closeness to the original', bossRow && bossRow.points === expected);
  assert('the others are scored 0..100 vs the original', others.every((r) => r.base >= 0 && r.base <= 100));

  host.close();
  guest.close();
  server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nboss: all checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
