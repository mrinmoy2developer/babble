/**
 * server.js — Express static host + Socket.IO realtime layer for Babble.
 *
 * Thin transport: it maps socket events to Room methods and lets each Room
 * broadcast over its own Socket.IO room channel. All game logic lives in /src.
 */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { Room, makeCode } = require('./src/game');
const { g2p } = require('./src/phonetics');
const { synthPhonemesB64, backendName, warmup } = require('./src/tts');
const stats = require('./src/stats');
const profiles = require('./src/profiles');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// public player analytics (no auth — every profile is browsable by anyone)
app.get('/api/profiles', (req, res) => res.json({ profiles: profiles.list(req.query.q) }));
app.get('/api/profile/:id', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, string>} socketId -> roomCode */
const where = new Map();

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, (event, payload) => io.to(code).emit(event, payload));
    // feed each scored round / finished game into the public profile store
    room.onRoundComplete = (info) => {
      for (const row of info.rows) {
        if (!row.pid || !row.hasGuess) continue;
        profiles.recordRound(row.pid, {
          name: row.name, avatar: row.avatar, points: row.points,
          sourceKey: info.sourceKey, sourceLabel: info.sourceLabel, flag: info.flag,
        });
      }
    };
    room.onGameEnd = (rows) => {
      for (const row of rows) {
        if (!row.pid) continue;
        profiles.recordGame(row.pid, { finalScore: row.score, won: row.won });
      }
    };
    rooms.set(code, room);
  }
  return room;
}

function broadcastLobby(room) {
  io.to(room.code).emit('room:update', room.publicState());
}

function broadcastStats() {
  io.emit('stats', { ...stats.get(), online: io.engine.clientsCount });
}

io.on('connection', (socket) => {
  stats.addVisitor();
  socket.emit('stats', { ...stats.get(), online: io.engine.clientsCount });
  broadcastStats();

  socket.on('room:create', ({ name, avatar, pid }, ack) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = getOrCreateRoom(code);
    joinRoom(socket, room, name, avatar, pid);
    if (typeof ack === 'function') ack({ ok: true, code });
  });

  socket.on('room:join', ({ code, name, avatar, pid }, ack) => {
    code = (code || '').toString().toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' });
      return;
    }
    joinRoom(socket, room, name, avatar, pid);
    if (typeof ack === 'function') ack({ ok: true, code });
  });

  socket.on('room:settings', (patch) => {
    const room = currentRoom(socket);
    if (room && room.updateSettings(socket.id, patch || {})) broadcastLobby(room);
  });

  socket.on('player:name', ({ name }) => {
    const room = currentRoom(socket);
    if (room) {
      room.setName(socket.id, name);
      broadcastLobby(room);
    }
  });

  socket.on('player:avatar', ({ avatar }) => {
    const room = currentRoom(socket);
    if (room) {
      room.setAvatar(socket.id, avatar);
      broadcastLobby(room);
    }
  });

  // host adds / removes a computer player
  socket.on('bot:add', ({ level } = {}) => {
    const room = currentRoom(socket);
    if (room && socket.id === room.hostId && room.addBot(level)) broadcastLobby(room);
  });
  socket.on('bot:remove', ({ id } = {}) => {
    const room = currentRoom(socket);
    if (room && socket.id === room.hostId && room.removeBot(id)) broadcastLobby(room);
  });

  // anyone can call a vote to kick another (human) player
  socket.on('vote:kick', ({ targetId } = {}) => {
    const room = currentRoom(socket);
    if (!room) return;
    const res = room.voteKick(socket.id, targetId);
    if (!res) return;
    if (res.kicked) {
      const target = io.sockets.sockets.get(targetId);
      if (target) {
        target.emit('room:kicked', {});
        leaveRoom(target, `${res.name} was vote-kicked`);
      }
      broadcastLobby(room);
    } else {
      io.to(room.code).emit('kick:vote', res);
    }
  });

  // in-game chat — relayed to everyone in the room
  let lastChat = 0;
  socket.on('chat:send', ({ text }) => {
    const room = currentRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - lastChat < 350) return; // light anti-spam throttle
    lastChat = now;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    io.to(room.code).emit('chat:msg', { id: socket.id, name: p.name, avatar: p.avatar, text: clean });
  });

  socket.on('game:start', () => {
    const room = currentRoom(socket);
    if (room && room.start(socket.id)) { stats.addGame(); broadcastStats(); }
  });

  socket.on('guess:submit', ({ text, final }) => {
    const room = currentRoom(socket);
    if (room) room.submitGuess(socket.id, text, final); // room broadcasts the tally
  });

  socket.on('round:force', () => {
    const room = currentRoom(socket);
    if (room) room.forceReveal(socket.id);
  });

  // host: skip the reveal countdown straight to the next round
  socket.on('round:next', () => {
    const room = currentRoom(socket);
    if (room) room.advance(socket.id);
  });

  // host: pause / resume the round clock
  socket.on('game:pause', () => {
    const room = currentRoom(socket);
    if (room) room.pause(socket.id);
  });
  socket.on('game:resume', () => {
    const room = currentRoom(socket);
    if (room) room.resume(socket.id);
  });

  // public-lobby browser: list joinable public rooms
  socket.on('rooms:list', (_d, ack) => {
    if (typeof ack === 'function') ack({ rooms: publicRooms() });
  });

  // Live "hear my guess": decode the typed text to phonemes and synth it,
  // using the room's answer language — the same decoder used for scoring.
  socket.on('guess:preview', async ({ text }, ack) => {
    const room = currentRoom(socket);
    if (!room || typeof ack !== 'function') return;
    const audio = await synthPhonemesB64(g2p(text || '', room.settings.answerLang), {
      voice: room.settings.voice,
    });
    ack({ audio });
  });

  // Slower re-render of the current target for the "slower" button.
  socket.on('word:slow', async (_d, ack) => {
    const room = currentRoom(socket);
    if (!room || typeof ack !== 'function') return;
    ack({ audio: (await room.renderCurrentSlow()) || '' });
  });

  socket.on('disconnect', () => { leaveRoom(socket); broadcastStats(); });
  socket.on('room:leave', () => leaveRoom(socket));
});

function joinRoom(socket, room, name, avatar, pid) {
  leaveRoom(socket); // ensure single-room membership
  socket.join(room.code);
  where.set(socket.id, room.code);
  const player = room.addPlayer(socket.id, name, avatar, pid);
  socket.emit('room:joined', { you: player.id, ...room.publicState() });
  broadcastLobby(room);
  io.to(room.code).emit('chat:msg', { system: true, text: `${player.name} joined` });
}

function leaveRoom(socket, reason) {
  const code = where.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  where.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  const left = room.players.get(socket.id);
  room.removePlayer(socket.id);
  // tear the room down once no humans remain (bots alone don't keep it alive)
  if (room.isEmpty() || !room.hasHumans()) {
    room.dispose();
    rooms.delete(code);
  } else {
    broadcastLobby(room);
    const who = left ? left.name : 'A player';
    io.to(room.code).emit('chat:msg', { system: true, text: reason || `${who} left` });
  }
}

function currentRoom(socket) {
  const code = where.get(socket.id);
  return code ? rooms.get(code) : null;
}

function publicRooms() {
  return [...rooms.values()]
    .filter((r) => r.settings.visibility === 'public' && r.players.size > 0)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => r.summary());
}

const PORT = process.env.PORT || 3000;
// Behind a reverse proxy, set HOST=127.0.0.1 so the app is only reachable via
// the proxy. Default 0.0.0.0 keeps the simple "open the IP:port" setup working.
const HOST = process.env.HOST || '0.0.0.0';

server
  .listen(PORT, HOST, () => {
    const tts = backendName();
    console.log(`Babble running on http://${HOST}:${PORT}`);
    console.log(`TTS backend: ${tts}`);
    if (tts === 'none') {
      console.warn('  ⚠ No speech engine found — words will be silent. Options:');
      console.warn('    • piper (neural, natural): set PIPER_VOICES_DIR=/path/to/voices (+ PIPER_PY)');
      console.warn('    • espeak-ng (robotic): sudo apt install espeak-ng');
      console.warn('    • macOS: the built-in `say` is used automatically');
      console.warn('    Force one with BABBLE_TTS=piper|say|espeak.');
    } else {
      warmup(); // pre-load piper so the first round is instant (no-op otherwise)
    }
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✖ Port ${PORT} is already in use — another server is running.`);
      console.error(`  Stop it (e.g. \`pkill -f 'node server.js'\`) or start on another port: PORT=3001 npm start\n`);
      process.exit(1);
    }
    throw err;
  });
