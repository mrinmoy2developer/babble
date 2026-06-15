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
    const inGame = ['play', 'reveal', 'over'].includes(name);
    $('chat-widget').classList.toggle('on', inGame);
    if (!inGame) $('chat-panel').hidden = true;
    // background letters + melody on the menu screens, quiet during play
    const menu = ['join', 'lobby', 'over'].includes(name);
    if (menu) { bgLetters.start(); if (music.on) music.start(); } else { bgLetters.stop(); music.stop(); }
    syncHostControls();
  }

  // ----- local state -------------------------------------------------------
  // Avatars are real Egyptian hieroglyphs (Unicode, rendered with the Noto Sans
  // Egyptian Hieroglyphs web font) in a separately-chosen colour, stored as
  // "glyph|#rrggbb". The glyphs slowly rotate (see .avatar.glyph in style.css).
  const COLORS = ['#ff6b81', '#00d4b8', '#ffb454', '#8a7bff', '#3ddc97', '#ff9bd6',
    '#5ad1ff', '#ffd24d', '#b491ff', '#ff5d73', '#36d399', '#7c5cff'];
  const HIERO_CP = [
    0x13000, 0x13012, 0x1301C, 0x13035, 0x13050, 0x13076, 0x13079, 0x13080, 0x130A7, 0x130C0,
    0x130ED, 0x130F5, 0x13100, 0x1313F, 0x13153, 0x13171, 0x13191, 0x13193, 0x131A3, 0x131CB,
    0x131F3, 0x13216, 0x13250, 0x13283, 0x132AA, 0x132F9, 0x13313, 0x13333, 0x1335B, 0x133CF,
  ];
  const GLYPHS = HIERO_CP.map((cp) => String.fromCodePoint(cp));
  const rand = (a) => a[Math.floor(Math.random() * a.length)];

  function parseAvatar(a) {
    const m = String(a || '').match(/^(.+)\|(#[0-9a-fA-F]{6})$/);
    return m ? { glyph: m[1], color: m[2] } : null;
  }
  const composeAvatar = (g, c) => `${g}|${c}`;

  const me = { id: null, name: localStorage.getItem('babble.name') || '' };
  {
    let pa = parseAvatar(localStorage.getItem('babble.avatar'));
    if (!pa || !GLYPHS.includes(pa.glyph)) pa = { glyph: rand(GLYPHS), color: (pa && pa.color) || rand(COLORS) };
    me.glyph = pa.glyph; me.color = pa.color; me.avatar = composeAvatar(me.glyph, me.color);
    localStorage.setItem('babble.avatar', me.avatar);
  }
  // a stable, public profile id so a player's stats follow them across games
  function genPid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'p-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }
  me.pid = localStorage.getItem('babble.pid');
  if (!me.pid) { me.pid = genPid(); localStorage.setItem('babble.pid', me.pid); }

  // circular flag for a language pack (ISO code -> image, special token -> emoji badge)
  function flagHtml(flag) {
    const e = { dice: '🎲', isle: '🏝️', elf: '🧝', orc: '👹' };
    if (e[flag]) return `<span class="flag">${e[flag]}</span>`;
    return `<span class="flag"><img loading="lazy" src="https://flagcdn.com/w40/${flag}.png" alt="" /></span>`;
  }
  const avatarSpan = (a) => {
    const p = parseAvatar(a);
    if (p) return `<span class="avatar glyph" style="color:${p.color}">${escapeHtml(p.glyph)}</span>`;
    return a ? `<span class="avatar">${escapeHtml(a)}</span>` : ''; // legacy emoji
  };
  // a small persistent profile (offline; "Sign in with Google" could sync this later)
  const profile = (() => { try { return JSON.parse(localStorage.getItem('babble.profile')) || {}; } catch (_) { return {}; } })();
  function renderProfile() {
    const el = $('profile');
    if (profile.games) {
      el.innerHTML = `${avatarSpan(me.avatar)} <b>${escapeHtml(me.name || 'You')}</b> · ${profile.games} game${profile.games > 1 ? 's' : ''} played · best <b>${profile.best || 0}</b> · 🏆 ${profile.wins || 0} win${profile.wins === 1 ? '' : 's'}`;
    } else { el.textContent = ''; }
  }
  // build a character + colour picker into a container (used on join + in lobby)
  function buildAvatarPicker(boxId) {
    const box = $(boxId);
    if (!box) return;
    box.classList.add('avatar-build');
    box.innerHTML =
      '<div class="ab-row-label">Colour</div><div class="ab-colors"></div>' +
      '<div class="ab-row-label">Character</div><div class="ab-glyphs"></div>';
    const colors = box.querySelector('.ab-colors');
    COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ab-color'; b.dataset.color = c; b.style.background = c;
      b.title = 'Colour'; if (c === me.color) b.classList.add('sel');
      b.onclick = () => { me.color = c; commitAvatar(); };
      colors.appendChild(b);
    });
    const glyphs = box.querySelector('.ab-glyphs');
    GLYPHS.forEach((ch) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ab-glyph'; b.dataset.glyph = ch; b.textContent = ch;
      b.style.color = me.color;
      if (ch === me.glyph) b.classList.add('sel');
      b.onclick = () => { me.glyph = ch; commitAvatar(); };
      glyphs.appendChild(b);
    });
  }
  // paint a "current avatar" chip with the chosen rune + colour
  function paintAvatarCur(el) { el.innerHTML = avatarSpan(me.avatar); }
  // apply the current glyph+colour everywhere and tell the room
  function commitAvatar() {
    me.avatar = composeAvatar(me.glyph, me.color);
    localStorage.setItem('babble.avatar', me.avatar);
    socket.emit('player:avatar', { avatar: me.avatar }); // live-update if already in a room
    document.querySelectorAll('.ab-color').forEach((x) => x.classList.toggle('sel', x.dataset.color === me.color));
    document.querySelectorAll('.ab-glyph').forEach((x) => { x.style.color = me.color; x.classList.toggle('sel', x.dataset.glyph === me.glyph); });
    document.querySelectorAll('.avatar-cur').forEach(paintAvatarCur);
    renderProfile();
    sfx.blip(660, 0.06);
  }
  buildAvatarPicker('avatar-picker');
  buildAvatarPicker('lobby-avatar-picker');
  document.querySelectorAll('.avatar-cur').forEach(paintAvatarCur);
  let state = null; // last room snapshot
  let current = { audio: '', buffer: null }; // current round target
  let answerLang = 'en';
  let previewWaves = true;
  let playRate = 1; // in-game playback speed (per-player; 0.5×–1.5×)
  let kickTally = {}; // targetId -> { votes, needed } for the lobby kick display
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
  // a single shared "simple playback" slot: starting a new sound cuts off the
  // previous one, so mashing ▶ restarts the word instead of stacking copies.
  let simpleSrc = null;
  function stopSimple() { if (simpleSrc) { try { simpleSrc.stop(); } catch (_) {} simpleSrc = null; } }
  function playBuffer(buf, rate = 1) {
    const c = ctx();
    if (!c || !buf) return;
    stopSimple();
    if (activeViz) { activeViz.stop(); activeViz = null; } // also halt a waveform player
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(c.destination);
    src.onended = () => { if (simpleSrc === src) simpleSrc = null; };
    simpleSrc = src;
    src.start();
  }
  async function playB64(b64, rate = 1) { try { playBuffer(await decode(b64), rate); } catch (_) {} }

  // tint a #rrggbb colour lighter (+) or darker (-) by a percent
  function shade(hex, pct) {
    const n = parseInt(hex.slice(1), 16);
    const f = (s) => { const v = Math.max(0, Math.min(255, ((n >> s) & 255) + Math.round(255 * pct / 100))); return v; };
    return `rgb(${f(16)},${f(8)},${f(0)})`;
  }
  // professional-looking waveform: mirrored, rounded bars with a soft gradient
  // and a faint centre line. peaks are gently compressed so quiet detail shows.
  function drawWave(canvas, buf, { color = '#00d4b8', alpha = 1, clear = true } = {}) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr)));
    const H = (canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr)));
    const g = canvas.getContext('2d');
    if (clear) {
      g.clearRect(0, 0, W, H);
      g.globalAlpha = 0.5; g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, Math.round(H / 2) - Math.ceil(dpr / 2), W, Math.max(1, Math.round(dpr))); // centre line
      g.globalAlpha = 1;
    }
    if (!buf) return;
    const data = buf.getChannelData(0);
    const mid = H / 2;
    const barW = Math.max(2 * dpr, 3 * dpr), gap = 2 * dpr, step = barW + gap;
    const nbars = Math.max(1, Math.floor((W + gap) / step));
    const block = Math.max(1, Math.floor(data.length / nbars));
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, shade(color, 12));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, shade(color, -16));
    g.globalAlpha = alpha; g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < nbars; i++) {
      const s = i * block;
      let peak = 0;
      for (let j = 0; j < block; j++) { const v = Math.abs(data[s + j] || 0); if (v > peak) peak = v; }
      const h = Math.max(1.5 * dpr, Math.pow(peak, 0.82) * (mid - dpr) * 1.9);
      const x = i * step;
      const r = Math.min(barW / 2, h);
      if (g.roundRect) g.roundRect(x, mid - h, barW, h * 2, r);
      else { g.moveTo(x, mid - h); g.rect(x, mid - h, barW, h * 2); } // older browsers
    }
    g.fill();
    g.globalAlpha = 1;
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
    let src = null, t0 = 0, off = 0, raf = null, playing = false, scrub = null, curRate = 1;

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
      const t = off + (ctx().currentTime - t0) * curRate; // buffer pos advances at the playback rate
      if (t >= dur) { drawAt(dur); stop(); setTimeout(reset, 450); return; }
      drawAt(t); raf = requestAnimationFrame(frame);
    };
    const play = (offset = 0, rate = 1) => {
      stopSimple(); // don't let raw playback bleed under the waveform player
      if (activeViz && activeViz !== api) activeViz.stop();
      activeViz = api;
      stop();
      const c = ctx(); if (!c) return;
      curRate = rate;
      src = c.createBufferSource(); src.buffer = buffer; src.playbackRate.value = curRate; src.connect(c.destination);
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
    // --- per-button click flavours (short, light) ---
    pop() { this.blip(480 + Math.random() * 130, 0.07, 'sine', 0.15); },          // default: bubbly
    clickPrimary() { this.blip(620, 0.06, 'triangle', 0.17); setTimeout(() => this.blip(950, 0.09, 'triangle', 0.15), 55); }, // confident up-boop
    clickToggle() { this.blip(900, 0.045, 'sine', 0.12); },                        // soft tick
    clickDanger() { this.blip(250, 0.06, 'square', 0.13); setTimeout(() => this.blip(170, 0.09, 'square', 0.11), 55); },      // low thunk
  };
  // map a button to its click sound by class, then animate the press
  function uiClick(btn, x, y) {
    if (music.on) {
      if (btn.classList.contains('danger')) sfx.clickDanger();
      else if (btn.classList.contains('primary') || btn.classList.contains('big-btn')) sfx.clickPrimary();
      else if (btn.classList.contains('seg') || btn.classList.contains('chat-toggle') ||
               btn.classList.contains('music-toggle') || btn.classList.contains('hud-btn')) sfx.clickToggle();
      else sfx.pop();
    }
    // springy press, independent of the CSS :active nudge
    try {
      btn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.9)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    } catch (_) {}
    // a little ripple splash at the touch point
    if (x != null) {
      const r = document.createElement('span');
      r.className = 'tap-ripple';
      r.style.left = x + 'px'; r.style.top = y + 'px';
      document.body.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    }
  }
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (btn && !btn.disabled) uiClick(btn, e.clientX, e.clientY);
  }, true);

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

  // ----- animated multilingual background letters --------------------------
  // colourful letters from every game language drift in curved paths; members of
  // the same script trail each other like a snake, and trains bump at crossings.
  const SCRIPTS = [
    { c: '#ff6b81', g: 'ABRKWMQ' },          // latin
    { c: '#00d4b8', g: 'অআকখবলমন' },         // bengali
    { c: '#ffb454', g: 'あいうねこさカナ' },    // japanese
    { c: '#8a7bff', g: 'αβγδΩΣΦΨ' },          // greek
    { c: '#3ddc97', g: 'ЯЖФДБГИ' },           // cyrillic
    { c: '#ff9bd6', g: 'كلمنهعص' },           // arabic
    { c: '#5ad1ff', g: '가나다라한글' },         // korean
    { c: '#ffd24d', g: '你好字文中語' },         // chinese
    { c: '#b491ff', g: 'कखगअआइउ' },           // devanagari
  ];
  const FONT_PRE = '700 ', FONT_POST = 'px "Fredoka", system-ui, "Noto Sans", sans-serif';
  const bgLetters = {
    running: false, raf: null, trains: [], W: 0, H: 0, dpr: 1, canvas: null, g: null,
    last: 0, _tick: null,
    init() {
      this.canvas = $('bg-letters');
      if (!this.canvas) return;
      this.g = this.canvas.getContext('2d');
      this._tick = () => this.frame();
      this.resize();
      window.addEventListener('resize', () => this.resize());
    },
    resize() {
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = this.canvas.width = Math.floor(innerWidth * this.dpr);
      this.H = this.canvas.height = Math.floor(innerHeight * this.dpr);
      const count = Math.max(16, Math.min(30, Math.round(innerWidth / 45)));
      this.trains = [];
      for (let i = 0; i < count; i++) this.trains.push(this.makeTrain(i));
    },
    // a "mother duck + ducklings" chain that enters from just off-screen
    makeTrain(i) {
      const s = SCRIPTS[i % SCRIPTS.length];
      const size = (22 + Math.random() * 16) * this.dpr;
      const spacing = size * 1.4;                  // clear gap -> no clumping
      const members = 4 + Math.floor(Math.random() * 5); // 4..8 ducklings
      const edge = Math.floor(Math.random() * 4);
      let x, y, a; // leader sits JUST off-screen; the tail trails further out
      const spread = (Math.random() - 0.5) * (Math.PI / 3);
      if (edge === 0) { x = -size; y = Math.random() * this.H; a = spread; }
      else if (edge === 1) { x = this.W + size; y = Math.random() * this.H; a = Math.PI + spread; }
      else if (edge === 2) { x = Math.random() * this.W; y = -size; a = Math.PI / 2 + spread; }
      else { x = Math.random() * this.W; y = this.H + size; a = -Math.PI / 2 + spread; }
      const nodes = [];
      for (let k = 0; k < members; k++) {
        nodes.push({ x: x - Math.cos(a) * spacing * k, y: y - Math.sin(a) * spacing * k, bob: Math.random() * 6.28, pop: 0 });
      }
      return { color: s.c, glyphs: [...s.g], nodes, a, speed: (0.9 + Math.random() * 0.9) * this.dpr, phase: Math.random() * 100, size, spacing, fade: 0, entered: false };
    },
    offscreen(tr) {
      const m = tr.size + tr.spacing;
      return tr.nodes.every((n) => n.x < -m || n.x > this.W + m || n.y < -m || n.y > this.H + m);
    },
    // react to a tap/click: nearby letters scatter + pop
    poke(cx, cy) {
      const R = 130 * this.dpr;
      for (const tr of this.trains) for (const n of tr.nodes) {
        const dx = n.x - cx, dy = n.y - cy, d = Math.hypot(dx, dy) || 1;
        if (d < R) { const f = 1 - d / R; n.x += (dx / d) * f * 70 * this.dpr; n.y += (dy / d) * f * 70 * this.dpr; n.pop = Math.max(n.pop, f); }
      }
    },
    start() { if (this.running || !this.g) return; this.running = true; this.last = 0; this.raf = requestAnimationFrame(this._tick); },
    stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); if (this.g) this.g.clearRect(0, 0, this.W, this.H); },
    frame() {
      if (!this.running) return;
      const g = this.g; const t = performance.now();
      // delta-time: scale all motion to a 60fps baseline so speed stays constant
      // and frame-rate dips no longer make the letters stutter or jump.
      const dt = this.last ? Math.min(3, Math.max(0.2, (t - this.last) / 16.667)) : 1;
      this.last = t;
      g.clearRect(0, 0, this.W, this.H);
      // mother ducks bumping at crossings -> bounce apart + pop
      for (let i = 0; i < this.trains.length; i++) {
        for (let j = i + 1; j < this.trains.length; j++) {
          const A = this.trains[i].nodes[0], B = this.trains[j].nodes[0];
          if (Math.hypot(A.x - B.x, A.y - B.y) < (this.trains[i].size + this.trains[j].size) * 0.55) {
            this.trains[i].a += 0.5; this.trains[j].a -= 0.5; A.pop = B.pop = 1;
          }
        }
      }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      let curFont = '', curFill = '';
      for (let idx = 0; idx < this.trains.length; idx++) {
        const tr = this.trains[idx];
        tr.fade = Math.min(1, tr.fade + 0.01 * dt);
        tr.a += (Math.sin(t * 0.0006 + tr.phase) * 0.025 + (Math.random() - 0.5) * 0.02) * dt;
        const lead = tr.nodes[0];
        lead.x += Math.cos(tr.a) * tr.speed * dt;
        lead.y += Math.sin(tr.a) * tr.speed * dt;
        // ducklings: each follows the one ahead at a fixed distance
        for (let k = 1; k < tr.nodes.length; k++) {
          const a = tr.nodes[k - 1], b = tr.nodes[k];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          b.x = a.x + (dx / d) * tr.spacing;
          b.y = a.y + (dy / d) * tr.spacing;
        }
        // only recycle a train once it has actually entered and then fully left
        const s = tr.size;
        if (!tr.entered && tr.nodes.some((n) => n.x > -s && n.x < this.W + s && n.y > -s && n.y < this.H + s)) tr.entered = true;
        if (tr.entered && this.offscreen(tr)) { this.trains[idx] = this.makeTrain(idx); continue; }
        // one fillStyle per train (colour is constant within a chain)
        if (tr.color !== curFill) { g.fillStyle = tr.color; curFill = tr.color; }
        // draw tail -> head, each letter bouncing/popping like a little critter
        for (let k = tr.nodes.length - 1; k >= 0; k--) {
          const n = tr.nodes[k];
          n.pop = Math.max(0, n.pop - 0.04 * dt);
          if (Math.random() < 0.0007 * dt) n.pop = 1; // spontaneous pop
          const bob = Math.sin(t * 0.004 + n.bob) * 4 * this.dpr;
          const squash = 1 + Math.sin(t * 0.003 + n.bob) * 0.05; // gentle dribble
          const sc = (1 + n.pop * 0.7) * squash;
          g.globalAlpha = Math.max(0.12, (0.92 - k * 0.06) * tr.fade);
          // round the px size so identical-size letters reuse one parsed font;
          // setting ctx.font is costly, so only reassign when it actually changes.
          const f = FONT_PRE + Math.round(tr.size * sc) + FONT_POST;
          if (f !== curFont) { g.font = f; curFont = f; }
          g.fillText(tr.glyphs[k % tr.glyphs.length], n.x, n.y + bob);
        }
      }
      g.globalAlpha = 1;
      this.raf = requestAnimationFrame(this._tick);
    },
  };

  // ----- playful background melody (synthesised, toggleable) ---------------
  const music = {
    on: localStorage.getItem('babble.music') !== 'off',
    playing: false, timer: null, step: 0, master: null, tuneIdx: 0, waves: null,
    // a handful of playful tunes in friendly keys. each names its own lead
    // instrument (piano / harp / bell / triangle) so the colour shifts as the
    // music drifts from one tune to the next — but the warm sine bass keeps the
    // whole thing grounded in Babble's feel.
    tunes: [
      { lead: 'piano', // C major — bright and bouncy
        melody: [523.25, 659.25, 783.99, 880, 783.99, 659.25, 587.33, 659.25, 523.25, 659.25, 783.99, 1046.5],
        bass: [130.81, 130.81, 174.61, 196.0] },
      { lead: 'harp', // A minor pentatonic — a touch wistful, hummable
        melody: [440, 523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25, 440, 523.25, 659.25, 587.33],
        bass: [110, 146.83, 164.81, 130.81] },
      { lead: 'triangle', // G major — skippy and upbeat
        melody: [392, 493.88, 587.33, 783.99, 659.25, 587.33, 493.88, 587.33, 392, 493.88, 587.33, 783.99],
        bass: [98, 146.83, 164.81, 130.81] },
      { lead: 'piano', // F major — round and warm
        melody: [349.23, 440, 523.25, 698.46, 523.25, 440, 392, 440, 349.23, 523.25, 698.46, 523.25],
        bass: [87.31, 116.54, 130.81, 98] },
      { lead: 'harp', // D major — sparkly and open
        melody: [587.33, 739.99, 880, 1174.66, 880, 739.99, 659.25, 739.99, 587.33, 440, 587.33, 739.99],
        bass: [146.83, 110, 98, 110] },
      { lead: 'bell', // E minor pentatonic — dreamy
        melody: [659.25, 783.99, 880, 987.77, 1174.66, 987.77, 880, 783.99, 659.25, 783.99, 880, 987.77],
        bass: [164.81, 123.47, 146.83, 110] },
    ],
    // build (once) the richer timbres as cached PeriodicWaves — harmonic recipes
    // that give plain oscillators a piano / harp / bell colour. cheap to reuse.
    ensureWaves() {
      const c = ctx(); if (!c || this.waves) return;
      const make = (h) => {
        const real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1);
        h.forEach((v, i) => { imag[i + 1] = v; });
        return c.createPeriodicWave(real, imag, { disableNormalization: false });
      };
      this.waves = {
        piano: make([1, 0.62, 0.42, 0.28, 0.18, 0.12, 0.08, 0.05]),
        harp: make([1, 0.55, 0.42, 0.33, 0.26, 0.2, 0.14, 0.1, 0.07]),
        bell: make([1, 0, 0.6, 0, 0.38, 0, 0.22, 0, 0.12]),
      };
    },
    start() {
      const c = ctx();
      if (!c || this.playing || !this.on) return;
      this.ensureWaves();
      this.playing = true; this.step = 0;
      this.master = c.createGain(); this.master.gain.value = 0; this.master.connect(c.destination);
      this.master.gain.linearRampToValueAtTime(0.05, c.currentTime + 1.2);
      this.tick();
    },
    tick() {
      if (!this.playing) return;
      const c = ctx(); const t = c.currentTime; const beat = 0.32;
      const tune = this.tunes[this.tuneIdx];
      this.note(tune.melody[this.step % tune.melody.length], t, beat * 0.9, tune.lead, 0.5);
      if (this.step % 2 === 0) this.note(tune.bass[Math.floor(this.step / 2) % tune.bass.length], t, beat * 1.7, 'sine', 0.5);
      // every other bar, a quick harp arpeggio sparkles over the top
      if (this.step % 8 === 6) {
        const m = tune.melody, i = this.step % m.length;
        for (let k = 0; k < 3; k++) this.note(m[(i + k * 2) % m.length] * 2, t + k * 0.07, 0.5, 'harp', 0.14);
      }
      this.step += 1;
      // let each tune breathe for two full passes before drifting to the next
      if (this.step % (tune.melody.length * 2) === 0) this.tuneIdx = (this.tuneIdx + 1) % this.tunes.length;
      this.timer = setTimeout(() => this.tick(), beat * 1000);
    },
    note(freq, t, dur, instr, g) {
      const c = ctx(); const o = c.createOscillator(), ga = c.createGain();
      const w = this.waves && this.waves[instr];
      if (w) o.setPeriodicWave(w); else o.type = instr; // 'sine' / 'triangle' fall through
      o.frequency.value = freq; o.connect(ga); ga.connect(this.master);
      // plucked instruments get a near-instant attack; pads a touch softer
      const atk = (instr === 'sine' || instr === 'triangle') ? 0.02 : 0.005;
      ga.gain.setValueAtTime(0, t); ga.gain.linearRampToValueAtTime(g, t + atk);
      ga.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.03);
    },
    stop() {
      this.playing = false; clearTimeout(this.timer);
      if (this.master) { try { this.master.gain.linearRampToValueAtTime(0, ctx().currentTime + 0.3); } catch (_) {} }
    },
    toggle() {
      this.on = !this.on;
      localStorage.setItem('babble.music', this.on ? 'on' : 'off');
      updateMusicBtn();
      if (this.on) this.start(); else this.stop();
    },
  };
  function updateMusicBtn() {
    const b = $('music-toggle');
    b.textContent = music.on ? '🎵' : '🔇';
    b.classList.toggle('off', !music.on);
  }
  $('music-toggle').onclick = () => music.toggle();
  updateMusicBtn();
  bgLetters.init();
  bgLetters.start(); // run on the intro screen too
  // first interaction anywhere unlocks the melody (browser autoplay policy);
  // taps/clicks also poke the nearby letters so they scatter and pop.
  document.addEventListener('pointerdown', (e) => {
    bgLetters.poke(e.clientX * bgLetters.dpr, e.clientY * bgLetters.dpr);
    if (music.on) music.start();
  });
  document.addEventListener('keydown', () => { if (music.on) music.start(); });

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
    bgLetters.start();
    music.start();
    // arrived via an invite link with a name already set? jump straight in.
    if (inviteCode && me.name) joinByCode(inviteCode);
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

  // ----- chat (lobby panel + floating in-game widget share one log) --------
  const chatLog = [];
  let chatUnread = 0;
  function chatEl(m) {
    const li = document.createElement('li');
    if (m.system) { li.className = 'c-sys'; li.textContent = m.text; }
    else li.innerHTML = `${avatarSpan(m.avatar)} <span class="c-name">${escapeHtml(m.name)}</span>: ${escapeHtml(m.text)}`;
    return li;
  }
  function addChat(m) {
    chatLog.push(m); if (chatLog.length > 120) chatLog.shift();
    ['lobby-chat-list', 'float-chat-list'].forEach((id) => {
      const list = $(id); if (!list) return;
      list.appendChild(chatEl(m));
      while (list.children.length > 120) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    });
    if (['play', 'reveal', 'over'].includes(activeName()) && $('chat-panel').hidden && !m.system) {
      chatUnread += 1;
      const u = $('chat-unread'); u.hidden = false; u.textContent = chatUnread > 9 ? '9+' : chatUnread;
      sfx.blip(720, 0.05);
    }
  }
  socket.on('chat:msg', addChat);
  function sendChat(input) {
    const t = input.value.trim(); if (!t) return;
    socket.emit('chat:send', { text: t }); input.value = '';
  }
  $('lobby-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('lobby-chat-input')); });
  $('float-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('float-chat-input')); });
  $('chat-toggle').onclick = () => {
    const panel = $('chat-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      chatUnread = 0; $('chat-unread').hidden = true;
      $('float-chat-list').scrollTop = $('float-chat-list').scrollHeight;
      $('float-chat-input').focus();
    }
  };
  $('chat-close').onclick = () => { $('chat-panel').hidden = true; };

  // ----- invite link + deep-link join -------------------------------------
  $('btn-invite').onclick = async () => {
    const code = (state && state.code) || $('room-code').textContent.trim();
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
    try { await navigator.clipboard.writeText(link); toast('🔗 Invite link copied — share it!'); }
    catch (_) { window.prompt('Copy this invite link:', link); }
  };
  const inviteCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
  if (inviteCode) $('code-input').value = inviteCode;

  // ----- tiny canvas charts for the analytics page (no libraries) ----------
  function chartBase(cv, height) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 560;
    cv.width = Math.round(W * dpr); cv.height = Math.round(height * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, height);
    return { g, W, H: height };
  }
  function chartEmpty(g, W, H, msg) {
    g.fillStyle = '#6a6f9e'; g.font = '12px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(msg, W / 2, H / 2); g.textAlign = 'left';
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function drawLineChart(cv, vals) {
    const { g, W, H } = chartBase(cv, 150);
    const padL = 26, padR = 10, padT = 12, padB = 16;
    const x0 = padL, x1 = W - padR, yTop = padT, yBot = H - padB;
    const yAt = (v) => yBot + (yTop - yBot) * (Math.max(0, Math.min(100, v)) / 100);
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.fillStyle = '#7c80ad'; g.lineWidth = 1; g.font = '10px system-ui';
    [0, 50, 100].forEach((v) => { const y = yAt(v); g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.fillText(String(v), 4, y + 3); });
    if (!vals.length) { chartEmpty(g, W, H, 'No rounds yet'); return; }
    const n = vals.length;
    const xAt = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (i / (n - 1)));
    g.beginPath(); g.moveTo(xAt(0), yBot);
    vals.forEach((v, i) => g.lineTo(xAt(i), yAt(v)));
    g.lineTo(xAt(n - 1), yBot); g.closePath();
    g.fillStyle = 'rgba(0,212,184,.12)'; g.fill();
    g.beginPath(); vals.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = '#00d4b8'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#7c5cff';
    vals.forEach((v, i) => { g.beginPath(); g.arc(xAt(i), yAt(v), n > 30 ? 1.6 : 2.6, 0, 6.283); g.fill(); });
  }
  function drawHist(cv, hist) {
    const { g, W, H } = chartBase(cv, 150);
    const padL = 8, padR = 8, padT = 12, padB = 18;
    const x0 = padL, x1 = W - padR, yBot = H - padB, yTop = padT;
    const total = hist.reduce((a, b) => a + b, 0);
    if (!total) { chartEmpty(g, W, H, 'No rounds yet'); return; }
    const max = Math.max(...hist), n = hist.length, bw = (x1 - x0) / n;
    g.font = '9px system-ui'; g.textAlign = 'center';
    hist.forEach((c, i) => {
      const h = max ? (yBot - yTop) * (c / max) : 0;
      const x = x0 + i * bw + bw * 0.16, w = bw * 0.68;
      if (c > 0 && h >= 1) {
        g.fillStyle = i >= 8 ? '#36d399' : i >= 5 ? '#00d4b8' : i >= 3 ? '#7c5cff' : '#ff5d73';
        roundRect(g, x, yBot - h, w, h, 3); g.fill();
      }
      g.fillStyle = '#7c80ad';
      g.fillText(i === 10 ? '100' : String(i * 10), x0 + i * bw + bw / 2, H - 5);
    });
    g.textAlign = 'left';
  }
  function describeDist(hist, avg) {
    const total = hist.reduce((a, b) => a + b, 0);
    if (!total) return '';
    let mode = 0; hist.forEach((c, i) => { if (c > hist[mode]) mode = i; });
    const range = mode === 10 ? '100' : `${mode * 10}–${mode * 10 + 9}`;
    const tier = avg >= 80 ? 'a razor-sharp ear 🦻' : avg >= 60 ? 'a solid ear 👂' : avg >= 40 ? 'a warming-up ear 🌱' : 'a wild guesser 🎲';
    const pct = Math.round((hist[mode] / total) * 100);
    return `Most guesses (${pct}%) land in the ${range} range — average closeness ${avg}/100. You’ve got ${tier}.`;
  }

  // ----- public profiles + analytics overlay -------------------------------
  const profilesUI = (() => {
    const modal = $('profiles-modal');
    let currentId = null;

    function open() { modal.classList.add('on'); showDir(); }
    function close() { modal.classList.remove('on'); }
    function showDir() {
      $('profile-detail').hidden = true;
      $('profiles-dir').hidden = false;
      $('profiles-back').hidden = true;
      $('profiles-msg').hidden = true;
      $('profiles-title').textContent = '👥 Player profiles';
      loadDir($('profiles-q').value.trim());
    }

    async function loadDir(q) {
      const ul = $('profiles-list');
      ul.innerHTML = '<li class="muted pl-empty">Loading…</li>';
      let data;
      try { data = await fetch('/api/profiles' + (q ? '?q=' + encodeURIComponent(q) : '')).then((r) => r.json()); }
      catch (_) { ul.innerHTML = '<li class="muted pl-empty">Couldn’t load profiles.</li>'; return; }
      const list = (data && data.profiles) || [];
      if (!list.length) {
        ul.innerHTML = `<li class="muted pl-empty">${q ? 'No players match that name.' : 'No players yet — play a game to be the first!'}</li>`;
        return;
      }
      ul.innerHTML = '';
      list.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'row';
        li.innerHTML =
          `<span class="prank">${i + 1}</span>` +
          `<span class="pavatar">${avatarSpan(p.avatar) || '🙂'}</span>` +
          `<span class="pname">${escapeHtml(p.name)}${p.id === me.pid ? ' <small class="muted">(you)</small>' : ''}</span>` +
          `<span class="pmeta">${p.games} game${p.games === 1 ? '' : 's'} · avg ${p.avg}<br>best ${p.best} · 🏆 ${p.wins}</span>`;
        li.onclick = () => openProfile(p.id);
        ul.appendChild(li);
      });
    }

    async function openProfile(id) {
      modal.classList.add('on');
      $('profiles-dir').hidden = true;
      $('profiles-msg').hidden = true;
      $('profile-detail').hidden = false;
      $('profiles-back').hidden = false;
      $('profiles-title').textContent = '📊 Profile';
      $('pd-name').textContent = 'Loading…';
      $('pd-meta').textContent = ''; $('pd-stats').innerHTML = ''; $('pd-langs').innerHTML = ''; $('pd-dist').textContent = '';
      let p;
      try { const r = await fetch('/api/profile/' + encodeURIComponent(id)); if (!r.ok) throw 0; p = await r.json(); }
      catch (_) {
        $('profile-detail').hidden = true;
        const m = $('profiles-msg'); m.hidden = false;
        m.textContent = id === me.pid
          ? 'No stats yet — play a round and your analytics will appear here!'
          : 'That profile has no stats yet.';
        return;
      }
      render(p);
    }

    const stat = (b, label) => `<div class="stat"><b>${b}</b><span>${label}</span></div>`;
    function render(p) {
      currentId = p.id;
      $('pd-avatar').innerHTML = avatarSpan(p.avatar) || '🙂';
      $('pd-name').textContent = p.name + (p.id === me.pid ? ' (you)' : '');
      const since = p.firstSeen ? new Date(p.firstSeen).toLocaleDateString() : '';
      $('pd-meta').textContent = since ? `Playing since ${since}` : '';
      $('pd-stats').innerHTML =
        stat(p.games, 'games') + stat(p.wins, 'wins') + stat(p.rounds, 'rounds') +
        stat(p.avg, 'avg score') + stat(p.best, 'best round') + stat(p.bestGame, 'best game');
      const langs = p.langs || [], lu = $('pd-langs');
      lu.innerHTML = langs.length
        ? langs.map((l) =>
            `<li><span class="lf">${flagHtml(l.flag)} ${escapeHtml(l.label)}</span>` +
            `<span class="lbar"><i style="width:${Math.max(3, l.avg)}%"></i></span>` +
            `<span class="lv"><b>${l.avg}</b> <small>· ${l.rounds}×</small></span></li>`).join('')
        : '<li class="muted">No language data yet.</li>';
      // draw after the panel is laid out so the canvases have a real width
      requestAnimationFrame(() => {
        drawLineChart($('pd-line'), (p.recent || []).map((r) => r.points));
        drawHist($('pd-hist'), p.hist || []);
      });
      $('pd-dist').textContent = describeDist(p.hist || [], p.avg);
    }

    $('btn-profiles').onclick = open;
    $('btn-my-stats').onclick = () => openProfile(me.pid);
    if ($('btn-over-stats')) $('btn-over-stats').onclick = () => openProfile(me.pid);
    $('profiles-close').onclick = close;
    $('profiles-back').onclick = showDir;
    $('profiles-refresh').onclick = () => loadDir($('profiles-q').value.trim());
    let qDeb = null;
    $('profiles-q').addEventListener('input', () => { clearTimeout(qDeb); qDeb = setTimeout(() => loadDir($('profiles-q').value.trim()), 250); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    $('pd-share').onclick = async () => {
      const link = `${location.origin}${location.pathname}?profile=${encodeURIComponent(currentId || me.pid)}`;
      try { await navigator.clipboard.writeText(link); toast('🔗 Profile link copied!'); }
      catch (_) { window.prompt('Copy this profile link:', link); }
    };
    return { open, openProfile };
  })();

  // deep-link straight to a profile: ?profile=<id>
  (() => {
    const pid = new URLSearchParams(location.search).get('profile');
    if (!pid) return;
    const intro = $('intro'); // drop the splash so the profile is interactive
    if (intro) intro.classList.remove('on');
    setTimeout(() => profilesUI.openProfile(pid), 300);
  })();

  // ----- join screen + public lobbies -------------------------------------
  function nameVal() {
    const n = $('name-input').value.trim() || 'Player';
    me.name = n; localStorage.setItem('babble.name', n);
    return n;
  }
  function joinByCode(code) {
    ctx();
    socket.emit('room:join', { code, name: nameVal(), avatar: me.avatar, pid: me.pid }, (res) => {
      if (!res.ok) $('join-error').textContent = res.error || 'Could not join';
    });
  }
  $('btn-create').onclick = () => {
    ctx();
    socket.emit('room:create', { name: nameVal(), avatar: me.avatar, pid: me.pid }, (res) => {
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

    const isHostNow = s.hostId === me.id;
    const botLabel = (key) => { const l = (s.botLevels || []).find((x) => x.key === key); return l ? l.label : 'Bot'; };
    const ul = $('player-list');
    ul.innerHTML = '';
    s.players.forEach((p) => {
      const li = document.createElement('li');
      let right = p.isHost ? '<span class="crown">👑</span>' : '';
      if (p.isBot) {
        right += `<span class="bot-tag">🤖 ${escapeHtml(botLabel(p.botLevel))}</span>`;
        if (isHostNow) right += `<button class="botx-btn" data-bot="${p.id}" title="Remove bot">✕</button>`;
      } else if (p.id !== me.id) {
        const v = kickTally[p.id];
        if (v) right += `<span class="kick-votes">${v.votes}/${v.needed}</span>`;
        right += `<button class="kick-btn" data-kick="${p.id}" title="Vote to kick">Kick</button>`;
      }
      li.innerHTML =
        `<span class="pl-main">${p.id === me.id ? '➤ ' : ''}${avatarSpan(p.avatar)} ${escapeHtml(p.name)}` +
        `${p.id === me.id ? ' <small class="muted">(you)</small>' : ''}</span>` +
        `<span class="pl-right">${right}</span>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('[data-kick]').forEach((b) => { b.onclick = () => socket.emit('vote:kick', { targetId: b.dataset.kick }); });
    ul.querySelectorAll('[data-bot]').forEach((b) => { b.onclick = () => socket.emit('bot:remove', { id: b.dataset.bot }); });

    // bot-add panel (host only, when bots are allowed)
    const botPanel = $('bot-panel');
    botPanel.hidden = !(isHostNow && s.settings.allowBots);
    if (!botPanel.hidden && s.botLevels && $('bot-add-row').dataset.built !== '1') {
      const row = $('bot-add-row'); row.innerHTML = '';
      s.botLevels.forEach((l) => {
        const b = document.createElement('button');
        b.type = 'button'; b.innerHTML = `${avatarSpan(l.avatar)} ${escapeHtml(l.label)}`;
        b.onclick = () => socket.emit('bot:add', { level: l.key });
        row.appendChild(b);
      });
      $('bot-add-row').dataset.built = '1';
    }

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
    setCheck('set-earlybonus', !!s.settings.earlyBonus);
    setCheck('set-bots', !!s.settings.allowBots);

    // "you" editor reflects current name + avatar
    setIfIdle('lobby-name', me.name || '');
    paintAvatarCur($('lobby-avatar-cur'));

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
      earlyBonus: $('set-earlybonus').checked,
      allowBots: $('set-bots').checked,
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
  $('set-earlybonus').onchange = pushSettings;
  $('set-bots').onchange = pushSettings;
  $('voice-select').onchange = pushSettings;

  // lobby "you" editor — rename + restyle yourself after joining
  let nameDeb = null;
  $('lobby-name').addEventListener('input', () => {
    const n = $('lobby-name').value.trim();
    if (!n) return;
    me.name = n; localStorage.setItem('babble.name', n);
    $('name-input').value = n; // keep the join screen in sync
    clearTimeout(nameDeb);
    nameDeb = setTimeout(() => socket.emit('player:name', { name: n }), 300);
  });
  $('lobby-avatar-btn').onclick = () => { const pk = $('lobby-avatar-picker'); pk.hidden = !pk.hidden; };

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
  // ▶ Play always uses a clean 1× reference; only the speed button uses the slider,
  // so reveal / next-round playback is never stuck at a previous round's speed.
  const playWordAt = (rate) => { if (origPlayer) origPlayer.play(0, rate); else playB64(current.audio, rate); };
  const playWord = () => playWordAt(1);
  $('btn-replay').onclick = playWord;
  $('btn-replay-target').onclick = playWord;
  $('btn-slow').onclick = () => playWordAt(playRate);

  // in-game playback speed (per-player; remembered across rounds). the button's
  // face follows the slider: snail → tortoise → hare → car → rocket.
  const fmtRate = (r) => r.toFixed(2).replace(/0$/, '') + '×';
  function speedInfo(r) {
    if (r <= 0.65) return { e: '🐌', t: 'Snail' };
    if (r <= 0.9) return { e: '🐢', t: 'Tortoise' };
    if (r < 1.1) return { e: '🐇', t: 'Hare' };
    if (r < 1.35) return { e: '🚗', t: 'Car' };
    return { e: '🚀', t: 'Rocket' };
  }
  function refreshSpeedUI() {
    const i = speedInfo(playRate);
    $('btn-slow').textContent = `${i.e} ${i.t}`;
    $('btn-slow').title = `Play the word at ${fmtRate(playRate)}`;
    $('speed-out').textContent = `${i.e} ${fmtRate(playRate)}`;
    $('speed').value = playRate;
  }
  (function initSpeed() {
    const saved = parseFloat(localStorage.getItem('babble.speed'));
    if (saved >= 0.5 && saved <= 1.5) playRate = saved;
    refreshSpeedUI();
  })();
  $('speed').addEventListener('input', () => {
    playRate = parseFloat($('speed').value) || 1;
    localStorage.setItem('babble.speed', String(playRate));
    refreshSpeedUI();
  });

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
    li.querySelector('.use').onclick = () => { $('guess-input').value = text; submitGuess(text, false); };
    list.prepend(li);
    const gbuf = await decode(audio).catch(() => null);
    const player = makePlayer(gbuf, li.querySelector('.wave'),
      { ghost: current.buffer, letters: [...li.querySelectorAll('.kchar')] });
    li.querySelector('.play-btn').onclick = () => player.play(0);
    player.play(0); // play + animate the moment you add it
  }

  let lockedIn = false; // have I finalised my answer this round?
  function setLocked(on) {
    lockedIn = on;
    $('guess-input').disabled = on;
    $('btn-submit').disabled = on;
    $('btn-lockin').disabled = on;
  }
  function submitGuess(text, final) {
    if (lockedIn) return; // already final this round — no take-backs
    socket.emit('guess:submit', { text, final: !!final });
    if (final) {
      setLocked(true);
      $('guess-status').textContent = text ? '🔒 Locked in — waiting for the others…' : '🔒 Locked in.';
    } else {
      $('guess-status').textContent = text
        ? '💾 Submitted — you can keep editing and re-submit until time runs out, or 🔒 Lock in to make it final.'
        : '';
    }
  }
  $('guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGuess($('guess-input').value.trim(), false); // Enter / Submit = tentative
  });
  $('btn-lockin').onclick = () => submitGuess($('guess-input').value.trim(), true);

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
  socket.on('room:joined', (s) => { me.id = s.you; kickTally = {}; renderLobby(s); });
  socket.on('kick:vote', (d) => {
    kickTally[d.targetId] = { votes: d.votes, needed: d.needed };
    if (activeName() === 'lobby' && state) renderLobby(state);
    toast(`🗳️ ${d.votes}/${d.needed} votes to kick ${escapeHtml(d.name)}`);
  });
  socket.on('room:kicked', () => {
    toast('🚫 You were removed from the room');
    setTimeout(() => location.reload(), 1200);
  });
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
    $('source-pill').innerHTML = `${flagHtml(d.flag)} ${escapeHtml(d.source)}`;
    $('syl-hint').textContent = `~${d.syllables} syllable${d.syllables > 1 ? 's' : ''}.`;
    $('guess-label').textContent = `Spell what you heard (${LANG_LABEL[answerLang] || answerLang})`;
    $('guess-input').value = '';
    setLocked(false); // re-enable input + buttons for the new round
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
    const drafting = (d.submitted || 0) - (d.locked || 0);
    $('submitted-count').textContent =
      `${d.locked || 0} / ${d.total} locked in` + (drafting > 0 ? ` · ${drafting} drafting…` : '');
    if (d.firstFinal && d.id !== me.id) {
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
    $('reveal-source').innerHTML = `${flagHtml(d.target.flag)} ${escapeHtml(d.target.source)}`;
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
        `${r.isBot ? ' <span class="bot-tag">🤖</span>' : ''}` +
        `<span class="guessed"> — “${r.guess ? spanLetters(r.guess) : '—'}”</span></span>` +
        `<span class="pts">+${r.points}${r.bonus ? `<span class="bonus" title="early-submission bonus">⚡+${r.bonus}</span>` : ''}</span>` +
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
