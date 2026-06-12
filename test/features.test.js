'use strict';
// E2E for the realtime features: public listing, lock-in broadcast,
// pause/resume, and host manual next-round. Starts its own server on PORT 3098.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3098;
const URL = `http://localhost:${PORT}`;
const server = spawn('node', ['server.js'], {
  cwd: require('path').join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev) => new Promise((res) => sock.once(ev, res));

let failures = 0;
const assert = (name, cond) => {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name); failures++; }
};

(async () => {
  await wait(700);
  const host = connect();
  const guest = connect();
  const browser = connect(); // a player sitting on the join screen
  await Promise.all([once(host, 'connect'), once(guest, 'connect'), once(browser, 'connect')]);

  const code = await new Promise((res) => host.emit('room:create', { name: 'Ada' }, (r) => res(r.code)));
  await new Promise((res) => guest.emit('room:join', { code, name: 'Bjarne' }, () => res()));
  host.emit('room:settings', { rounds: 2, roundSeconds: 30, revealSeconds: 5, visibility: 'public', sources: ['gibberish'] });
  await wait(200);

  // public listing
  const list = await new Promise((res) => browser.emit('rooms:list', {}, (r) => res(r.rooms)));
  assert('public room appears in browser list', list.some((r) => r.code === code && r.hostName === 'Ada'));

  // make it private -> should disappear
  host.emit('room:settings', { visibility: 'private' });
  await wait(150);
  const list2 = await new Promise((res) => browser.emit('rooms:list', {}, (r) => res(r.rooms)));
  assert('private room hidden from browser list', !list2.some((r) => r.code === code));

  // counters
  let roundStarts = 0;
  guest.on('round:start', () => { roundStarts++; });

  // chat relay (sender's name + avatar reach the room)
  const chatP = once(host, 'chat:msg');
  guest.emit('chat:send', { text: 'gl hf!' });
  const chat = await Promise.race([chatP, wait(1000)]);
  assert('chat message relays to the room', chat && chat.text === 'gl hf!' && chat.name === 'Bjarne');

  let lockSeen = null;
  host.on('guess:locked', (d) => { if (d.id !== host.id) lockSeen = d; });
  const pausedP = once(guest, 'game:paused');
  const resumedP = once(guest, 'game:resumed');

  host.emit('game:start');
  await once(guest, 'round:start');

  // lock-in broadcast
  guest.emit('guess:submit', { text: 'baba' });
  await wait(150);
  assert('host is told who locked in', lockSeen && lockSeen.name === 'Bjarne' && lockSeen.firstLock === true);

  // pause / resume
  host.emit('game:pause');
  await Promise.race([pausedP, wait(1000)]);
  host.emit('game:resume');
  const resumed = await Promise.race([resumedP, wait(1000)]);
  assert('guest received pause then resume (with new deadline)', resumed && typeof resumed.deadline === 'number');

  // host forces reveal, then manually advances to round 2
  host.emit('round:force');
  await once(host, 'round:reveal');
  host.emit('round:next');
  await Promise.race([once(guest, 'round:start'), wait(2000)]);
  assert('manual next-round started round 2', roundStarts === 2);

  host.close(); guest.close(); browser.close(); server.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nfeatures: all checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
