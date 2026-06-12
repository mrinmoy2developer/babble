/* Generates the README's SVG graphics (banner, diagrams, mockup).
   Run with: node assets/make-graphics.js   — committed so the art is reproducible. */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;

// palette (matches the app's theme)
const C = {
  bg: '#0f1020', bg2: '#171935', card: '#1d2046', card2: '#23264f',
  ink: '#eef0ff', muted: '#9aa0d0', line: '#2c2f63',
  accent: '#7c5cff', accent2: '#00d4b8', warn: '#ffb454', bad: '#ff5d73', good: '#36d399',
};
const FONT = 'Segoe UI, Roboto, Helvetica, Arial, sans-serif';

// deterministic pseudo-random so art is stable across runs
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// a waveform as stacked vertical lines
function waveform(x0, mid, width, n, ampMax, color, seed, sw = 2, alpha = 1) {
  const r = rng(seed);
  const step = width / n;
  let d = '';
  for (let i = 0; i < n; i++) {
    const env = Math.sin((i / n) * Math.PI); // fade in/out at the ends
    const h = (4 + r() * ampMax) * (0.35 + env);
    const x = +(x0 + i * step).toFixed(1);
    d += `M${x} ${(mid - h).toFixed(1)}L${x} ${(mid + h).toFixed(1)}`;
  }
  return `<path d="${d}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" opacity="${alpha}"/>`;
}

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}">${body}</svg>\n`;
}
function bubbles(seed, w, h, n) {
  const r = rng(seed); let s = '';
  for (let i = 0; i < n; i++) {
    const cx = r() * w, cy = r() * h, rad = 14 + r() * 46;
    s += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${C.accent}" opacity="${(0.04 + r() * 0.06).toFixed(2)}"/>`;
  }
  return s;
}

// ---- banner ----------------------------------------------------------------
function banner() {
  const w = 1200, h = 340;
  const letters = [['B', C.accent], ['a', '#9b6bff'], ['b', '#6f7bff'], ['b', '#2aa8ff'], ['l', C.accent2], ['e', '#2fe0b8']];
  const startX = 430, lx = 66;
  let word = '', shadow = '';
  letters.forEach(([ch, col], i) => {
    const x = startX + i * lx;
    shadow += `<text x="${x}" y="${201}" font-size="130" font-weight="800" fill="#0a0a18" opacity="0.7">${ch}</text>`;
    word += `<text x="${x}" y="${196}" font-size="130" font-weight="800" fill="${col}">${ch}</text>`;
  });
  const body = `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2a2d66"/><stop offset="0.6" stop-color="${C.bg}"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${bubbles(7, w, h, 14)}
    <text x="335" y="170" font-size="92">🗣️</text>
    ${shadow}${word}
    <text x="${w / 2}" y="250" font-size="27" fill="${C.muted}" text-anchor="middle">Hear a word in a strange tongue. Spell it. Closest <tspan fill="${C.accent2}">sound</tspan> wins.</text>
    ${waveform(330, 300, 540, 90, 26, C.accent2, 42, 2.4)}
    <text x="${w / 2}" y="332" font-size="15" fill="${C.muted}" text-anchor="middle" opacity="0.8">online multiplayer · skribbl.io meets Garlic Phone · but for sound</text>`;
  return svg(w, h, body);
}

// ---- gameplay flow ---------------------------------------------------------
function gameplay() {
  const w = 1100, h = 240;
  const steps = [['🔊', 'Hear', 'a generated word'], ['✍️', 'Spell', 'what you heard'], ['〰️', 'Compare', 'waveforms &amp; tweak'], ['🏆', 'Win', 'closest sound scores']];
  const cw = 220, gap = 50, x0 = (w - (steps.length * cw + (steps.length - 1) * gap)) / 2;
  let cards = '';
  steps.forEach(([icon, title, sub], i) => {
    const x = x0 + i * (cw + gap);
    cards += `
      <g transform="translate(${x},50)">
        <rect width="${cw}" height="140" rx="18" fill="${C.card}" stroke="${C.line}"/>
        <text x="${cw / 2}" y="66" font-size="46" text-anchor="middle">${icon}</text>
        <text x="${cw / 2}" y="100" font-size="24" font-weight="700" fill="${C.ink}" text-anchor="middle">${title}</text>
        <text x="${cw / 2}" y="124" font-size="14" fill="${C.muted}" text-anchor="middle">${sub}</text>
      </g>`;
    if (i < steps.length - 1) cards += `<text x="${x + cw + gap / 2}" y="128" font-size="34" fill="${C.accent}" text-anchor="middle">→</text>`;
  });
  return svg(w, h, `<rect width="${w}" height="${h}" fill="${C.bg}"/>${cards}`);
}

// ---- architecture ----------------------------------------------------------
function architecture() {
  const w = 1100, h = 560;
  function box(x, y, bw, bh, title, lines, accent) {
    let t = `<g transform="translate(${x},${y})"><rect width="${bw}" height="${bh}" rx="14" fill="${C.card}" stroke="${accent || C.line}" stroke-width="${accent ? 2 : 1}"/>`;
    t += `<text x="16" y="30" font-size="19" font-weight="700" fill="${accent || C.ink}">${title}</text>`;
    lines.forEach((l, i) => { t += `<text x="16" y="${56 + i * 22}" font-size="14" fill="${C.muted}">${l}</text>`; });
    return t + '</g>';
  }
  function arrow(x1, y1, x2, y2, label) {
    let s = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.accent2}" stroke-width="2" marker-end="url(#ah)"/>`;
    if (label) s += `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" font-size="13" fill="${C.muted}" text-anchor="middle">${label}</text>`;
    return s;
  }
  const body = `
    <defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0 0 L8 3 L0 6 z" fill="${C.accent2}"/></marker></defs>
    <rect width="${w}" height="${h}" fill="${C.bg}"/>
    <text x="${w / 2}" y="36" font-size="22" font-weight="700" fill="${C.ink}" text-anchor="middle">Architecture</text>
    ${box(60, 70, 360, 150, '🌐 Browser — public/client.js', ['• Web Audio: play WAV, draw waveforms', '• sounds, confetti, toasts, HUD', '• intro &amp; loading animations', '• Socket.IO client'], C.accent)}
    ${box(680, 70, 360, 150, '🖥️ Server — server.js', ['• Express static host', '• Socket.IO realtime transport', '• thin: maps events → Room methods', '• detects TTS backend on boot'], C.accent)}
    ${arrow(420, 130, 680, 130, 'Socket.IO (audio + state)')}
    ${arrow(680, 175, 420, 175, 'guesses')}
    ${box(680, 270, 360, 110, '🎯 src/game.js — Room state machine', ['lobby → (round → reveal) ×N → over', 'pause/resume · manual next · scoring'])}
    ${box(60, 270, 360, 110, '🔤 src/words.js — word engine', ['19 phonotactic packs + gibberish', 'generates phoneme sequences'])}
    ${box(60, 420, 360, 110, '👂 src/phonetics.js', ['g2p: text → phonemes (the decoder)', 'score: weighted phonetic edit distance'])}
    ${box(680, 420, 360, 110, '🗣️ src/tts.js', ['phonemes → WAV (macOS say / espeak-ng)', 'rendered server-side; answer never leaks'])}
    ${arrow(600, 325, 668, 325)}
    ${arrow(240, 380, 240, 420)}
    ${arrow(770, 380, 770, 420)}`;
  return svg(w, h, body);
}

// ---- scoring illustration --------------------------------------------------
function scoring() {
  const w = 1100, h = 340;
  function row(y, label, word, phon, color) {
    let s = `<text x="60" y="${y}" font-size="16" fill="${C.muted}">${label}</text>`;
    s += `<text x="60" y="${y + 30}" font-size="30" font-weight="700" fill="${C.ink}">"${word}"</text>`;
    phon.forEach((p, i) => {
      const x = 300 + i * 70;
      s += `<rect x="${x}" y="${y + 6}" width="56" height="40" rx="9" fill="${C.card}" stroke="${color}"/>`;
      s += `<text x="${x + 28}" y="${y + 33}" font-size="20" fill="${color}" text-anchor="middle">${p}</text>`;
    });
    return s;
  }
  const body = `
    <rect width="${w}" height="${h}" fill="${C.bg}"/>
    <text x="${w / 2}" y="40" font-size="22" font-weight="700" fill="${C.ink}" text-anchor="middle">Scored by sound, not spelling</text>
    ${row(80, 'TARGET', 'banana', ['b', 'a', 'n', 'a', 'n', 'a'], C.accent2)}
    ${row(170, 'GUESS', 'bununa', ['b', 'u', 'n', 'u', 'n', 'a'], C.accent)}
    <text x="60" y="270" font-size="15" fill="${C.muted}">2 vowels differ (a↔u) — small phonetic cost — the rest aligns perfectly</text>
    <rect x="60" y="285" width="980" height="20" rx="10" fill="${C.card}"/>
    <rect x="60" y="285" width="${980 * 0.86}" height="20" rx="10" fill="${C.accent2}"/>
    <text x="${60 + 980 * 0.86 - 10}" y="300" font-size="14" font-weight="700" fill="#04241f" text-anchor="end">86 / 100</text>`;
  return svg(w, h, body);
}

// ---- reveal screen mockup --------------------------------------------------
function revealMock() {
  const w = 760, h = 560;
  const rows = [
    ['🥇', 'Ada (you)', '“krindel”', '+92', C.accent2, 31, 0.95],
    ['🥈', 'Bjarne', '“grindle”', '+74', C.accent, 33, 0.7],
    ['🥉', 'Lin', '“kreendol”', '+58', C.accent, 37, 0.5],
  ];
  let list = '';
  rows.forEach(([m, name, guess, pts, col, seed, amp], i) => {
    const y = 250 + i * 96;
    list += `
      <g transform="translate(24,${y})">
        <rect width="${w - 48}" height="84" rx="12" fill="${C.card}"/>
        <text x="18" y="32" font-size="20">${m}</text>
        <circle cx="64" cy="26" r="15" fill="${C.card2}" stroke="${C.accent2}"/><text x="64" y="32" font-size="13" fill="${C.accent2}" text-anchor="middle">▶</text>
        <text x="92" y="31" font-size="17" font-weight="700" fill="${C.ink}">${name}</text>
        <text x="${92 + name.length * 9}" y="31" font-size="15" fill="${C.muted}">— ${guess}</text>
        <text x="${w - 70}" y="31" font-size="18" font-weight="700" fill="${C.accent2}" text-anchor="end">${pts}</text>
        ${waveform(20, 62, 320, 70, 14, C.accent, seed + 1, 2, 0.3)}
        ${waveform(20, 62, 320, 70, 14 * amp, C.accent2, seed, 2, 1)}
      </g>`;
  });
  const body = `
    <rect width="${w}" height="${h}" fill="${C.bg2}"/>
    <rect x="16" y="16" width="${w - 32}" height="${h - 32}" rx="18" fill="${C.card}" stroke="${C.line}"/>
    <text x="40" y="58" font-size="24" font-weight="700" fill="${C.ink}">Round 3 results</text>
    <g transform="translate(24,80)">
      <rect width="${w - 48}" height="120" rx="12" fill="${C.bg2}" stroke="${C.line}"/>
      <text x="18" y="28" font-size="14" fill="${C.muted}">Original <tspan fill="${C.accent2}">▶</tspan> · sounds like <tspan fill="${C.accent2}">k r i n d e l</tspan></text>
      ${waveform(20, 76, w - 88, 110, 22, C.accent2, 99, 2.4)}
    </g>
    ${list}
    <text x="${w / 2}" y="${h - 30}" font-size="14" fill="${C.muted}" text-anchor="middle">Next round in 12s…   ▸ host can skip</text>`;
  return svg(w, h, body);
}

// ---- social share card (Open Graph image, 1200x630) -----------------------
function ogCard() {
  const w = 1200, h = 630;
  const letters = [['B', C.accent], ['a', '#9b6bff'], ['b', '#6f7bff'], ['b', '#2aa8ff'], ['l', C.accent2], ['e', '#2fe0b8']];
  // one centred <text> so proportional letter widths stay even; a dark copy behind = 3D
  const tspans = letters.map(([ch, col]) => `<tspan fill="${col}">${ch}</tspan>`).join('');
  const plain = letters.map(([ch]) => ch).join('');
  const tAttrs = `font-size="118" font-weight="800" text-anchor="middle" letter-spacing="4"`;
  const shadow = `<text x="601" y="239" ${tAttrs} fill="#0a0a18" opacity="0.7">🗣️ ${plain}</text>`;
  const word = `<text x="600" y="234" ${tAttrs}>🗣️ ${tspans}</text>`;
  const steps = [['🔊', 'hear'], ['✍️', 'spell'], ['〰️', 'compare'], ['🏆', 'win']];
  let flow = '';
  const fx0 = 250, fcw = 150, fgap = 30;
  steps.forEach(([icon, lab], i) => {
    const x = fx0 + i * (fcw + fgap);
    flow += `<g transform="translate(${x},340)">
      <rect width="${fcw}" height="120" rx="16" fill="${C.card}" stroke="${C.line}"/>
      <text x="${fcw / 2}" y="62" font-size="42" text-anchor="middle">${icon}</text>
      <text x="${fcw / 2}" y="98" font-size="20" fill="${C.muted}" text-anchor="middle">${lab}</text></g>`;
    if (i < steps.length - 1) flow += `<text x="${x + fcw + fgap / 2}" y="412" font-size="30" fill="${C.accent}" text-anchor="middle">→</text>`;
  });
  const body = `
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d66"/><stop offset="0.65" stop-color="${C.bg}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${bubbles(7, w, h, 16)}
    ${shadow}${word}
    <text x="${w / 2}" y="288" font-size="30" fill="${C.muted}" text-anchor="middle">Hear a word in a strange tongue. Spell it. Closest <tspan fill="${C.accent2}">sound</tspan> wins.</text>
    ${flow}
    ${waveform(250, 510, 700, 100, 22, C.accent2, 7, 2.6)}
    <text x="${w / 2}" y="566" font-size="24" fill="${C.ink}" text-anchor="middle" font-weight="600">Free · Online Multiplayer · Plays in your browser</text>
    <text x="${w / 2}" y="600" font-size="22" fill="${C.accent2}" text-anchor="middle">babble.hebdo.duckdns.org</text>`;
  return svg(w, h, body);
}

const files = {
  'banner.svg': banner(),
  'gameplay.svg': gameplay(),
  'architecture.svg': architecture(),
  'scoring.svg': scoring(),
  'reveal-mockup.svg': revealMock(),
  'og.svg': ogCard(),
};
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), content);
  console.log('wrote', name, `(${content.length}b)`);
}
