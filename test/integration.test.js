'use strict';
// End-to-end: spin up the real server, run two players through a 1-round game.
// Usage: node test/integration.test.js   (starts its own server on PORT 3099)
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3099;
const URL = `http://localhost:${PORT}`;

const server = spawn('node', ['server.js'], {
  cwd: require('path').join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(700); // let the server bind
  const host = connect();
  const guest = connect();

  let revealSeen = null;
  let overSeen = null;

  await new Promise((res) => host.on('connect', res));
  await new Promise((res) => guest.on('connect', res));

  const code = await new Promise((res) =>
    host.emit('room:create', { name: 'Ada' }, (r) => res(r.code))
  );
  console.log('  ✓ host created room', code);

  await new Promise((res) => guest.emit('room:join', { code, name: 'Bjarne' }, () => res()));
  console.log('  ✓ guest joined');

  // 1 round, short timer; both auto-lock-in on round:start (which ends the round)
  host.emit('room:settings', { rounds: 1, roundSeconds: 3, revealSeconds: 5, difficulty: 2, sources: ['gibberish'] });
  await wait(150);

  let startSeen = null;
  host.on('round:start', (d) => { startSeen = d; });
  const guessFor = (sock, text) => sock.on('round:start', () => sock.emit('guess:submit', { text, final: true }));
  guessFor(host, 'bababa');
  guessFor(guest, 'lalala');

  host.on('round:reveal', (d) => { revealSeen = d; });
  const gameOver = new Promise((res) => host.on('game:over', (d) => { overSeen = d; res(); }));

  host.emit('game:start');
  await Promise.race([gameOver, wait(13000)]);

  let failures = 0;
  const assert = (name, cond) => {
    if (cond) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name); failures++; }
  };

  assert('round start delivered audio (no phonemes leaked)',
    startSeen && typeof startSeen.audio === 'string' && startSeen.audio.length > 100 && !('phonemes' in startSeen));
  assert('round reveal was broadcast', !!revealSeen);
  assert('reveal exposes target phonemes', revealSeen && Array.isArray(revealSeen.target.phonemes));
  assert('reveal includes target audio', revealSeen && typeof revealSeen.target.audio === 'string' && revealSeen.target.audio.length > 100);
  assert('two results scored', revealSeen && revealSeen.results.length === 2);
  assert('each guess has rendered audio', revealSeen && revealSeen.results.every((r) => typeof r.audio === 'string' && r.audio.length > 100));
  assert('scores are 0..100', revealSeen && revealSeen.results.every((r) => r.points >= 0 && r.points <= 100));
  assert('game over fired with leaderboard', overSeen && overSeen.leaderboard.length === 2);

  host.close();
  guest.close();
  server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nintegration: all checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
