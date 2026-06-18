'use strict';
// End-to-end Bluff mode: hear the word, submit a real guess + a decoy, vote on
// the decoys, and the decoy author scores for every voter it fools.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3096;
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

  const a = conn();
  const b = conn();
  await new Promise((r) => a.on('connect', r));
  await new Promise((r) => b.on('connect', r));
  const code = await new Promise((r) => a.emit('room:create', { name: 'Ana', pid: 'p-ana-bluff' }, (x) => r(x.code)));
  await new Promise((r) => b.emit('room:join', { code, name: 'Bex', pid: 'p-bex-bluff' }, () => r()));
  a.emit('room:settings', { mode: 'bluff', rounds: 1, roundSeconds: 6, revealSeconds: 3, sources: ['gibberish'] });
  await wait(150);

  let aStart = null, vote = null, reveal = null, aOwn = null, bOwn = null;
  a.on('round:start', (d) => { aStart = d; });
  a.on('round:vote', (d) => { vote = d; });
  a.on('bluff:own', (d) => { aOwn = d; });
  b.on('bluff:own', (d) => { bOwn = d; });
  a.on('round:reveal', (d) => { reveal = d; });

  a.emit('game:start');
  await waitFor(() => aStart);
  assert('round:start is bluff mode in the guess phase', aStart && aStart.mode === 'bluff' && aStart.phase === 'guess');
  assert('everyone hears the original in bluff', aStart && typeof aStart.audio === 'string' && aStart.audio.length > 100);

  // both submit a real guess + a decoy
  a.emit('bluff:submit', { real: 'ana', decoy: 'zarp' });
  b.emit('bluff:submit', { real: 'bex', decoy: 'quoll' });
  await waitFor(() => vote);

  assert('voting opens with both decoys', vote && Array.isArray(vote.decoys) && vote.decoys.length === 2);
  assert('decoys never reveal their author', vote && vote.decoys.every((x) => !('id' in x) && !('author' in x) && x.key && x.text && x.audio));
  assert('each player is told which decoy is their own', aOwn && aOwn.key && bOwn && bOwn.key && aOwn.key !== bOwn.key);

  // each votes for the OTHER's decoy
  const aOther = vote.decoys.find((x) => x.key !== aOwn.key).key;
  const bOther = vote.decoys.find((x) => x.key !== bOwn.key).key;
  a.emit('bluff:vote', { key: aOther });
  b.emit('bluff:vote', { key: bOther });
  await waitFor(() => reveal);

  assert('round:reveal received in bluff mode', reveal && reveal.mode === 'bluff' && reveal.bluff);
  assert('reveal lists every decoy with vote counts', reveal && reveal.bluff.decoys.length === 2);
  const total = reveal ? reveal.bluff.decoys.reduce((s, x) => s + x.votes, 0) : 0;
  assert('two votes were cast in total', total === 2);
  assert('a fooled decoy earns its author points-per-vote', reveal && reveal.bluff.decoys.every((x) => x.points === x.votes * reveal.bluff.pointsPerVote));

  a.close();
  b.close();
  server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nbluff: all checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
