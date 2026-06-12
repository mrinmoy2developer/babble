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
const { synthPhonemesB64, backendName } = require('./src/tts');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, string>} socketId -> roomCode */
const where = new Map();

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, (event, payload) => io.to(code).emit(event, payload));
    rooms.set(code, room);
  }
  return room;
}

function broadcastLobby(room) {
  io.to(room.code).emit('room:update', room.publicState());
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, ack) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = getOrCreateRoom(code);
    joinRoom(socket, room, name);
    if (typeof ack === 'function') ack({ ok: true, code });
  });

  socket.on('room:join', ({ code, name }, ack) => {
    code = (code || '').toString().toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' });
      return;
    }
    joinRoom(socket, room, name);
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

  socket.on('game:start', () => {
    const room = currentRoom(socket);
    if (room) room.start(socket.id);
  });

  socket.on('guess:submit', ({ text }) => {
    const room = currentRoom(socket);
    if (room) room.submitGuess(socket.id, text); // room broadcasts who locked in
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
    const audio = await synthPhonemesB64(g2p(text || '', room.settings.answerLang));
    ack({ audio });
  });

  // Slower re-render of the current target for the "slower" button.
  socket.on('word:slow', async (_d, ack) => {
    const room = currentRoom(socket);
    if (!room || typeof ack !== 'function') return;
    ack({ audio: (await room.renderCurrentSlow()) || '' });
  });

  socket.on('disconnect', () => leaveRoom(socket));
  socket.on('room:leave', () => leaveRoom(socket));
});

function joinRoom(socket, room, name) {
  leaveRoom(socket); // ensure single-room membership
  socket.join(room.code);
  where.set(socket.id, room.code);
  const player = room.addPlayer(socket.id, name);
  socket.emit('room:joined', { you: player.id, ...room.publicState() });
  broadcastLobby(room);
}

function leaveRoom(socket) {
  const code = where.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  where.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  room.removePlayer(socket.id);
  if (room.isEmpty()) {
    room.dispose();
    rooms.delete(code);
  } else {
    broadcastLobby(room);
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
      console.warn('  ⚠ No speech engine found. Install espeak-ng (e.g. `sudo apt install espeak-ng`)');
      console.warn('    or run on macOS, otherwise words will be silent.');
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
