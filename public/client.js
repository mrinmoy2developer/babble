/* Babble client — Socket.IO glue, Web Audio playback/waveforms, and game UX
   (sounds, confetti, toasts, HUD, pause, preview tries, public lobbies). */
(() => {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = {
    join: $('screen-join'),
    lobby: $('screen-lobby'),
    play: $('screen-play'),
    reveal: $('screen-reveal'),
    over: $('screen-over'),
  };
  function show(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
    $('hud').classList.toggle('on', name === 'play' || name === 'reveal');
    if (name !== 'play') $('paused-overlay').classList.remove('on');
    syncHostControls();
  }

  // ----- local state -------------------------------------------------------
  const AVATARS = ['🦊', '🐼', '🐧', '🐸', '🦄', '🐙', '🐯', '🐵', '🐶', '🐱', '🦁', '🐮',
    '🐷', '🐔', '🦉', '🐢', '🦖', '👽', '🤖', '🐲', '🐝', '🦋', '🐺', '🐨'];
  const me = { id: null, name: localStorage.getItem('babble.name') || '',
    avatar: localStorage.getItem('babble.avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)] };

  // circular flag for a language pack (ISO code -> image, special token -> emoji badge)
  function flagHtml(flag) {
    const e = { dice: '🎲', isle: '🏝️', elf: '🧝', orc: '👹' };
    if (e[flag]) return `<span class="flag">${e[flag]}</span>`;
    return `<span class="flag"><img loading="lazy" src="https://flagcdn.com/w40/${flag}.png" alt="" /></span>`;
  }
  const avatarSpan = (a) => (a ? `<span class="avatar">${escapeHtml(a)}</span>` : '');
  // a small persistent profile (offline; "Sign in with Google" could sync this later)
  const profile = (() => { try { return JSON.parse(localStorage.getItem('babble.profile')) || {}; } catch (_) { return {}; } })();
  function renderProfile() {
    const el = $('profile');
    if (profile.games) {
      el.innerHTML = `${avatarSpan(me.avatar)} <b>${escapeHtml(me.name || 'You')}</b> · ${profile.games} game${profile.games > 1 ? 's' : ''} played · best <b>${profile.best || 0}</b> · 🏆 ${profile.wins || 0} win${profile.wins === 1 ? '' : 's'}`;
    } else { el.textContent = ''; }
  }
  function buildAvatarPicker() {
    const box = $('avatar-picker');
    box.innerHTML = '';
    AVATARS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = a;
      if (a === me.avatar) b.classList.add('sel');
      b.onclick = () => {
        me.avatar = a;
        localStorage.setItem('babble.avatar', a);
        box.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        socket.emit('player:avatar', { avatar: a }); // live-update if already in a room
        renderProfile();
        sfx.blip(660, 0.06);
      };
      box.appendChild(b);
    });
  }
  buildAvatarPicker();
  let state = null; // last room snapshot
  let current = { audio: '', buffer: null }; // current round target
  let answerLang = 'en';
  let previewWaves = true;
  let timerInt = null;
  let lastTickSec = -1;
  let paused = false;
  if (me.name) $('name-input').value = me.name;
  renderProfile();

  const amIHost = () => !!(state && state.hostId === me.id);

  // ----- Web Audio: decode + play + draw ----------------------------------
  const AC = window.AudioContext || window.webkitAudioContext;
  let actx = null;
  const bufCache = new Map();

  function ctx() {
    if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  if (!AC) $('tts-warn').textContent = 'Your browser has no Web Audio — playback disabled.';

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function decode(b64) {
    if (!b64) return null;
    if (bufCache.has(b64)) return bufCache.get(b64);
    const c = ctx();
    if (!c) return null;
    const buf = await c.decodeAudioData(b64ToBytes(b64).buffer);
    bufCache.set(b64, buf);
    return buf;
  }
  function playBuffer(buf) {
    const c = ctx();
    if (!c || !buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start();
  }
  async function playB64(b64) { try { playBuffer(await decode(b64)); } catch (_) {} }

  function drawWave(canvas, buf, { color = '#00d4b8', alpha = 1, clear = true } = {}) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr)));
    const H = (canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr)));
    const g = canvas.getContext('2d');
    if (clear) g.clearRect(0, 0, W, H);
    if (!buf) return;
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / W));
    const mid = H / 2;
    g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = dpr;
    g.beginPath();
    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let j = 0; j < step; j++) { const v = data[start + j]; if (v < min) min = v; if (v > max) max = v; }
      g.moveTo(x + 0.5, mid + min * mid * 0.92);
      g.lineTo(x + 0.5, mid + max * mid * 0.92);
    }
    g.stroke(); g.globalAlpha = 1;
  }

  // ----- a player with a scrubbable playhead + karaoke letter shading ------
  let activeViz = null;
  function spanLetters(text) {
    return [...String(text)].map((c) =>
      c === ' ' ? ' ' : `<span class="kchar">${escapeHtml(c)}</span>`).join('');
  }
  function makePlayer(buffer, canvas, { ghost = null, letters = [] } = {}) {
    if (!buffer || !canvas) return { play() {}, stop() {} };
    // swap in a fresh node so reused canvases (orig/target) don't stack listeners
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
    const dpr = window.devicePixelRatio || 1;
    const dur = buffer.duration;
    let src = null, t0 = 0, off = 0, raf = null, playing = false, scrub = null;

    const drawStatic = () => {
      drawWave(canvas, ghost, { color: '#7c5cff', alpha: 0.28, clear: true });
      drawWave(canvas, buffer, { color: '#00d4b8', alpha: 1, clear: false });
    };
    const drawAt = (t) => {
      drawStatic();
      const g = canvas.getContext('2d');
      const x = Math.max(0, Math.min(1, t / dur)) * canvas.width;
      g.strokeStyle = '#ffb454'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, canvas.height); g.stroke();
      const frac = t / dur;
      letters.forEach((el, i) => el.classList.toggle('lit', (i + 0.5) / letters.length <= frac));
    };
    const reset = () => { letters.forEach((el) => el.classList.remove('lit')); drawStatic(); };
    const stop = () => {
      if (src) { try { src.stop(); } catch (_) {} src = null; }
      playing = false; if (raf) cancelAnimationFrame(raf);
    };
    const frame = () => {
      if (!playing) return;
      const t = off + (ctx().currentTime - t0);
      if (t >= dur) { drawAt(dur); stop(); setTimeout(reset, 450); return; }
      drawAt(t); raf = requestAnimationFrame(frame);
    };
    const play = (offset = 0) => {
      if (activeViz && activeViz !== api) activeViz.stop();
      activeViz = api;
      stop();
      const c = ctx(); if (!c) return;
      src = c.createBufferSource(); src.buffer = buffer; src.connect(c.destination);
      off = Math.max(0, Math.min(dur, offset)); t0 = c.currentTime;
      src.start(0, off); playing = true; frame();
    };

    // freely scrollable playhead: drag to set position, release to play from there
    const posOf = (e) => {
      const r = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
    };
    let dragging = false;
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      stop(); scrub = posOf(e); drawAt(scrub);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) { scrub = posOf(e); drawAt(scrub); } });
    canvas.addEventListener('pointerup', () => { if (dragging) { dragging = false; play(scrub || 0); } });

    const api = { play, stop, drawStatic };
    drawStatic();
    return api;
  }

  // ----- sound effects (synthesised, no asset files) ----------------------
  const sfx = {
    blip(freq, dur = 0.08, type = 'sine', gain = 0.2) {
      const c = ctx(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = freq;
      o.connect(g); g.connect(c.destination);
      const t = c.currentTime;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur);
    },
    tick(urgent) { this.blip(urgent ? 1180 : 760, 0.05, 'square', urgent ? 0.22 : 0.12); },
    lock() { this.blip(520, 0.07); setTimeout(() => this.blip(780, 0.07), 70); },
    ding() { this.blip(880, 0.12); setTimeout(() => this.blip(1320, 0.16), 110); },
    win() { [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this.blip(f, 0.2, 'triangle', 0.22), i * 130)); },
  };

  // ----- confetti ----------------------------------------------------------
  function confettiBurst() {
    const canvas = $('confetti');
    canvas.classList.add('on');
    const g = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = innerWidth * dpr);
    const H = (canvas.height = innerHeight * dpr);
    const colors = ['#7c5cff', '#00d4b8', '#ffb454', '#ff5d73', '#36d399', '#ffffff'];
    const parts = [];
    for (let i = 0; i < 170; i++) parts.push({
      x: Math.random() * W, y: -Math.random() * H * 0.4,
      vx: (Math.random() - 0.5) * 6 * dpr, vy: (2 + Math.random() * 4) * dpr,
      s: (4 + Math.random() * 6) * dpr, rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.3, c: colors[i % colors.length],
    });
    const start = performance.now();
    (function frame(now) {
      const t = now - start;
      g.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.05 * dpr; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
        g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); g.restore();
      }
      if (t < 3200) requestAnimationFrame(frame);
      else { g.clearRect(0, 0, W, H); canvas.classList.remove('on'); }
    })(start);
  }

  // ----- toasts ------------------------------------------------------------
  function toast(html) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 2900);
  }

  // ----- intro splash + loading screens -----------------------------------
  $('btn-enter').onclick = () => {
    ctx(); // first user gesture — unlocks Web Audio for the whole session
    sfx.ding();
    const intro = $('intro');
    intro.classList.add('fade-out');
    setTimeout(() => intro.classList.remove('on', 'fade-out'), 500);
  };

  const LOAD_MSGS = [
    'Summoning a word…', 'Tuning the vocal cords…', 'Inventing a language…',
    'Warming up the speakers…', 'Consulting the gibberish oracle…', 'Twisting some tongues…',
  ];
  function showLoading() {
    $('loading-msg').textContent = LOAD_MSGS[Math.floor(Math.random() * LOAD_MSGS.length)];
    $('loading').classList.add('on');
  }
  function hideLoading() { $('loading').classList.remove('on'); }

  // ----- join screen + public lobbies -------------------------------------
  function nameVal() {
    const n = $('name-input').value.trim() || 'Player';
    me.name = n; localStorage.setItem('babble.name', n);
    return n;
  }
  function joinByCode(code) {
    ctx();
    socket.emit('room:join', { code, name: nameVal(), avatar: me.avatar }, (res) => {
      if (!res.ok) $('join-error').textContent = res.error || 'Could not join';
    });
  }
  $('btn-create').onclick = () => {
    ctx();
    socket.emit('room:create', { name: nameVal(), avatar: me.avatar }, (res) => {
      if (!res.ok) $('join-error').textContent = res.error || 'Could not create room';
    });
  };
  $('btn-join').onclick = () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { $('join-error').textContent = 'Enter a 4-letter code'; return; }
    joinByCode(code);
  };
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

  const LANG_LABEL = { en: 'English', bn: 'Bengali', es: 'Spanish', mixed: 'English + Bengali' };
  function refreshRooms() {
    socket.emit('rooms:list', {}, (res) => {
      const list = (res && res.rooms) || [];
      const ul = $('rooms-list');
      ul.innerHTML = '';
      if (!list.length) {
        ul.innerHTML = '<li class="rooms-empty">No public games right now — create one!</li>';
        return;
      }
      list.forEach((r) => {
        const li = document.createElement('li');
        const live = r.state !== 'lobby';
        li.innerHTML =
          `<div class="room-row">` +
          `<span class="rc">${r.code}</span>` +
          `<span class="meta">${escapeHtml(r.hostName)}'s game · ${r.players} player${r.players !== 1 ? 's' : ''} · ${LANG_LABEL[r.answerLang] || r.answerLang}</span>` +
          `<span class="badge ${live ? 'live' : ''}">${live ? `round ${r.round}/${r.totalRounds}` : 'in lobby'}</span>` +
          `<button class="small">Join</button></div>`;
        li.querySelector('button').onclick = () => joinByCode(r.code);
        ul.appendChild(li);
      });
    });
  }
  $('btn-refresh-rooms').onclick = refreshRooms;
  setInterval(() => { if (screens.join.classList.contains('active')) refreshRooms(); }, 4000);

  // ----- lobby -------------------------------------------------------------
  function renderLobby(s) {
    state = s;
    $('room-code').textContent = s.code;
    answerLang = s.settings.answerLang;

    const ul = $('player-list');
    ul.innerHTML = '';
    s.players.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.id === me.id ? '➤ ' : ''}${avatarSpan(p.avatar)} ${escapeHtml(p.name)}</span>` +
        `<span>${p.isHost ? '<span class="crown">👑 host</span>' : ''}</span>`;
      ul.appendChild(li);
    });

    const box = $('source-checks');
    if (box.dataset.built !== '1') {
      box.innerHTML = '';
      s.sources.forEach((src) => {
        const id = `src-${src.key}`;
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" id="${id}" value="${src.key}"> ${flagHtml(src.flag)} ${escapeHtml(src.label)}`;
        box.appendChild(label);
        label.querySelector('input').onchange = pushSettings;
      });
      box.dataset.built = '1';
    }
    s.sources.forEach((src) => {
      const cb = $(`src-${src.key}`);
      if (cb && document.activeElement !== cb) cb.checked = s.settings.sources.includes(src.key);
    });

    // voices (only shown when the server has a piper backend with models)
    const voices = s.voices || [];
    const vsel = $('voice-select');
    $('voice-row').hidden = voices.length === 0;
    if (voices.length && vsel.dataset.sig !== voices.map((v) => v.id).join(',')) {
      vsel.innerHTML = '';
      voices.forEach((v) => {
        const o = document.createElement('option');
        o.value = v.id; o.textContent = v.label;
        vsel.appendChild(o);
      });
      vsel.dataset.sig = voices.map((v) => v.id).join(',');
    }
    if (voices.length && document.activeElement !== vsel) {
      vsel.value = s.settings.voice || voices[0].id;
    }

    setIfIdle('answer-lang', s.settings.answerLang);
    setRange('rounds', 'rounds-out', s.settings.rounds);
    setRange('secs', 'secs-out', s.settings.roundSeconds);
    setRange('reveal', 'reveal-out', s.settings.revealSeconds);
    setRange('diff', 'diff-out', s.settings.difficulty);
    setCheck('set-public', s.settings.visibility === 'public');
    setCheck('set-preview', s.settings.previewWaves);

    const isHost = s.hostId === me.id;
    $('settings').classList.toggle('locked', !isHost);
    $('btn-start').style.display = isHost ? '' : 'none';
    $('lobby-hint').textContent = isHost
      ? (s.players.length < 2 ? 'You can start solo, but it is more fun with friends!' : '')
      : 'Waiting for the host to start…';

    show('lobby');
  }
  function setIfIdle(id, val) { const el = $(id); if (document.activeElement !== el) el.value = val; }
  function setRange(id, outId, val) { const el = $(id); if (document.activeElement !== el) el.value = val; $(outId).textContent = val; }
  function setCheck(id, val) { const el = $(id); if (document.activeElement !== el) el.checked = val; }

  function pushSettings() {
    if (!state || state.hostId !== me.id) return;
    const sources = [...document.querySelectorAll('#source-checks input:checked')].map((c) => c.value);
    socket.emit('room:settings', {
      sources: sources.length ? sources : undefined,
      answerLang: $('answer-lang').value,
      voice: $('voice-select').value,
      rounds: +$('rounds').value,
      roundSeconds: +$('secs').value,
      revealSeconds: +$('reveal').value,
      difficulty: +$('diff').value,
      visibility: $('set-public').checked ? 'public' : 'private',
      previewWaves: $('set-preview').checked,
    });
  }
  ['answer-lang', 'rounds', 'secs', 'reveal', 'diff'].forEach((id) => {
    $(id).addEventListener('input', () => {
      if (id === 'rounds') $('rounds-out').textContent = $('rounds').value;
      if (id === 'secs') $('secs-out').textContent = $('secs').value;
      if (id === 'reveal') $('reveal-out').textContent = $('reveal').value;
      if (id === 'diff') $('diff-out').textContent = $('diff').value;
      pushSettings();
    });
  });
  $('set-public').onchange = pushSettings;
  $('set-preview').onchange = pushSettings;
  $('voice-select').onchange = pushSettings;

  // Simple/Advanced settings view (a per-player UI preference, not a room setting)
  function setMode(pro) {
    $('settings').classList.toggle('simple', !pro);
    $('mode-pro').classList.toggle('active', pro);
    $('mode-simple').classList.toggle('active', !pro);
    localStorage.setItem('babble.mode', pro ? 'pro' : 'simple');
  }
  $('mode-simple').onclick = () => setMode(false);
  $('mode-pro').onclick = () => setMode(true);
  setMode(localStorage.getItem('babble.mode') === 'pro');

  $('btn-start').onclick = () => { ctx(); showLoading(); socket.emit('game:start'); };
  $('btn-leave').onclick = () => { socket.emit('room:leave'); location.reload(); };
  $('btn-back-lobby').onclick = () => state && renderLobby(state);

  // ----- HUD: help / pause / exit -----------------------------------------
  function syncHostControls() {
    const host = amIHost();
    $('btn-pause').style.display = host ? '' : 'none';
    $('btn-pause').textContent = paused ? '▶' : '⏸';
    $('btn-resume').style.display = host ? '' : 'none';
    $('btn-next-round').style.display = host ? '' : 'none';
  }
  $('btn-help').onclick = () => $('help-modal').classList.add('on');
  $('btn-help-close').onclick = () => $('help-modal').classList.remove('on');
  $('btn-exit').onclick = () => {
    if (confirm('Leave this game?')) { socket.emit('room:leave'); location.reload(); }
  };
  $('btn-pause').onclick = () => socket.emit(paused ? 'game:resume' : 'game:pause');
  $('btn-resume').onclick = () => socket.emit('game:resume');

  // ----- play --------------------------------------------------------------
  let origPlayer = null; // play-screen "Original" waveform player (when preview on)
  const playWord = () => { if (origPlayer) origPlayer.play(0); else playB64(current.audio); };
  $('btn-replay').onclick = playWord;
  $('btn-replay-target').onclick = playWord;
  $('btn-slow').onclick = () => {
    $('think-word').hidden = false;
    socket.emit('word:slow', {}, (res) => {
      $('think-word').hidden = true;
      if (res && res.audio) playB64(res.audio);
    });
  };

  $('btn-hear-self').onclick = () => {
    const text = $('guess-input').value.trim();
    if (!text) return;
    $('think-guess').hidden = false;
    socket.emit('guess:preview', { text }, async (res) => {
      $('think-guess').hidden = true;
      if (!res || !res.audio) return;
      if (previewWaves) await addTry(text, res.audio);
      else playB64(res.audio);
    });
  };

  async function addTry(text, audio) {
    const list = $('tries-list');
    const empty = list.querySelector('.tries-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = 'try';
    li.innerHTML =
      `<button class="play-btn" title="Replay">▶</button>` +
      `<span class="txt">${spanLetters(text)}</span>` +
      `<button class="use">✓ Submit</button>` +
      `<canvas class="wave"></canvas>`;
    li.querySelector('.use').onclick = () => { $('guess-input').value = text; submitGuess(text); };
    list.prepend(li);
    const gbuf = await decode(audio).catch(() => null);
    const player = makePlayer(gbuf, li.querySelector('.wave'),
      { ghost: current.buffer, letters: [...li.querySelectorAll('.kchar')] });
    li.querySelector('.play-btn').onclick = () => player.play(0);
    player.play(0); // play + animate the moment you add it
  }

  function submitGuess(text) {
    socket.emit('guess:submit', { text });
    $('guess-status').textContent = text
      ? 'Locked in! You can still tweak it until time runs out.'
      : '';
  }
  $('guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGuess($('guess-input').value.trim());
  });

  function startTimer(deadline) {
    clearInterval(timerInt);
    lastTickSec = -1;
    const tick = () => {
      if (paused) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const t = $('timer');
      t.textContent = left + 's';
      t.classList.toggle('danger', left <= 10);
      if (left <= 10 && left > 0 && left !== lastTickSec) { sfx.tick(left <= 5); lastTickSec = left; }
      if (left <= 0) clearInterval(timerInt);
    };
    tick();
    timerInt = setInterval(tick, 250);
  }

  // ----- global stats (animated count-up) ---------------------------------
  const statShown = { online: 0, games: 0, visitors: 0 };
  function animateStat(id, key, to) {
    const el = $(id);
    const from = statShown[key];
    if (to === from) return;
    if (to > from) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    const steps = Math.min(20, Math.abs(to - from));
    let i = 0;
    const tick = () => {
      i += 1;
      el.textContent = Math.round(from + (to - from) * (i / steps)).toLocaleString();
      if (i < steps) requestAnimationFrame(tick);
      else { el.textContent = to.toLocaleString(); statShown[key] = to; }
    };
    if (steps > 0) tick(); else { el.textContent = to.toLocaleString(); statShown[key] = to; }
  }
  socket.on('stats', (d) => {
    animateStat('stat-online', 'online', d.online || 0);
    animateStat('stat-games', 'games', d.games || 0);
    animateStat('stat-visitors', 'visitors', d.visitors || 0);
  });

  // ----- socket events -----------------------------------------------------
  socket.on('connect', () => { me.id = socket.id; refreshRooms(); });
  socket.on('room:joined', (s) => { me.id = s.you; renderLobby(s); });
  socket.on('room:update', (s) => {
    if (['lobby', 'over'].includes(activeName())) renderLobby(s);
    else { state = s; syncHostControls(); }
  });

  socket.on('round:start', async (d) => {
    hideLoading();
    current = { audio: d.audio, buffer: null };
    answerLang = d.answerLang;
    previewWaves = !!d.previewWaves;
    paused = false;
    $('paused-overlay').classList.remove('on');
    $('round-now').textContent = d.round;
    $('round-total').textContent = d.totalRounds;
    $('source-pill').textContent = '🌍 ' + d.source;
    $('syl-hint').textContent = `~${d.syllables} syllable${d.syllables > 1 ? 's' : ''}.`;
    $('guess-label').textContent = `Spell what you heard (${LANG_LABEL[answerLang] || answerLang})`;
    $('guess-input').value = '';
    $('guess-status').textContent = '';
    $('submitted-count').textContent = '';
    $('think-word').hidden = true;
    $('think-guess').hidden = true;

    // preview area
    if (origPlayer) origPlayer.stop();
    origPlayer = null;
    $('preview-area').classList.toggle('on', previewWaves);
    $('tries-list').innerHTML = '<li class="tries-empty">Type a guess and press “Hear my guess” to stack a try here.</li>';
    show('play');
    $('guess-input').focus();
    startTimer(d.deadline);

    if (previewWaves) {
      current.buffer = await decode(d.audio).catch(() => null);
      origPlayer = makePlayer(current.buffer, $('orig-wave'), {});
      setTimeout(playWord, 250); // auto-play once, with the moving playhead
    } else {
      setTimeout(() => playB64(d.audio), 250);
    }
  });

  socket.on('guess:locked', (d) => {
    $('submitted-count').textContent = `${d.submitted} / ${d.total} locked in`;
    if (d.firstLock && d.id !== me.id) {
      toast(`<span class="lock">🔒</span> ${avatarSpan(d.avatar)} ${escapeHtml(d.name)} locked in their guess`);
      sfx.lock();
    }
  });

  socket.on('game:paused', () => {
    paused = true;
    clearInterval(timerInt);
    $('paused-overlay').classList.add('on');
    syncHostControls();
  });
  socket.on('game:resumed', (d) => {
    paused = false;
    $('paused-overlay').classList.remove('on');
    syncHostControls();
    startTimer(d.deadline);
  });

  socket.on('round:reveal', async (d) => {
    clearInterval(timerInt);
    if (origPlayer) origPlayer.stop();
    origPlayer = null;
    current = { audio: d.target.audio, buffer: null };
    $('reveal-round').textContent = d.round;
    $('reveal-source').textContent = d.target.source;
    // phoneme tokens as karaoke letters
    $('reveal-phon').innerHTML = d.target.phonemes.map((p) => `<span class="kchar">${p}</span>`).join(' ');
    sfx.ding();

    const ul = $('reveal-list');
    ul.innerHTML = '';
    const rows = d.results.map((r, i) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="rank">${medal(i)}</span>` +
        `<button class="play-btn" ${r.audio ? '' : 'disabled'} title="Play guess">▶</button>` +
        `<span class="who">${avatarSpan(r.avatar)} ${escapeHtml(r.name)}${r.id === me.id ? ' (you)' : ''}` +
        `<span class="guessed"> — “${r.guess ? spanLetters(r.guess) : '—'}”</span></span>` +
        `<span class="pts">+${r.points}</span>` +
        `<span class="total">${r.total} pts</span>` +
        `<canvas class="wave"></canvas>`;
      ul.appendChild(li);
      return { li, r };
    });

    $('reveal-next-hint').innerHTML = d.isLast
      ? `Final results in <span id="reveal-countdown">${d.nextInSeconds}</span>s…`
      : `Next round in <span id="reveal-countdown">${d.nextInSeconds}</span>s…`;
    $('btn-next-round').textContent = d.isLast ? 'See results ▶' : 'Next round ▶';
    show('reveal');

    let left = d.nextInSeconds;
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      left -= 1;
      const c = $('reveal-countdown'); if (c) c.textContent = Math.max(0, left);
      if (left <= 0) { clearInterval(timerInt); showLoading(); }
    }, 1000);

    // build players: target (karaoke over phonemes) + each guess (over its letters)
    const targetBuf = await decode(d.target.audio);
    const targetLetters = [...$('reveal-phon').querySelectorAll('.kchar')];
    const targetPlayer = makePlayer(targetBuf, $('target-wave'), { letters: targetLetters });
    $('btn-replay-target').onclick = () => targetPlayer.play(0);
    for (const { li, r } of rows) {
      const guessBuf = r.audio ? await decode(r.audio).catch(() => null) : null;
      const player = makePlayer(guessBuf, li.querySelector('.wave'),
        { ghost: targetBuf, letters: [...li.querySelectorAll('.kchar')] });
      const btn = li.querySelector('.play-btn');
      if (guessBuf) btn.onclick = () => player.play(0);
    }
  });
  $('btn-next-round').onclick = () => { showLoading(); socket.emit('round:next'); };

  socket.on('game:over', (d) => {
    clearInterval(timerInt);
    hideLoading();
    // update the local persistent profile
    const mine = d.leaderboard.find((p) => p.id === me.id);
    if (mine) {
      profile.games = (profile.games || 0) + 1;
      profile.total = (profile.total || 0) + mine.score;
      profile.best = Math.max(profile.best || 0, mine.score);
      if (d.leaderboard[0] && d.leaderboard[0].id === me.id) profile.wins = (profile.wins || 0) + 1;
      localStorage.setItem('babble.profile', JSON.stringify(profile));
      renderProfile();
    }
    const ul = $('final-list');
    ul.innerHTML = '';
    d.leaderboard.forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="rank">${medal(i)}</span>` +
        `<span class="who">${avatarSpan(p.avatar)} ${escapeHtml(p.name)}${p.id === me.id ? ' (you)' : ''}</span>` +
        `<span class="pts">${p.score}</span>`;
      ul.appendChild(li);
    });
    show('over');
    confettiBurst();
    sfx.win();
  });

  socket.on('disconnect', () => { $('tts-warn').textContent = 'Disconnected. Reload to rejoin.'; });

  // ----- helpers -----------------------------------------------------------
  function activeName() { return Object.keys(screens).find((k) => screens[k].classList.contains('active')); }
  function medal(i) { return ['🥇', '🥈', '🥉'][i] || `#${i + 1}`; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
