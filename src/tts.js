/**
 * tts.js — server-side speech synthesis.
 *
 * Every word in Babble is a phoneme sequence; we render it to a readable
 * spelling (see phonemesToSpelling) and let a speech engine pronounce it. The
 * same spelling always renders the same way for the target and every guess, so
 * scoring stays fair, and rendering on the server means the round payload
 * carries only audio — never the answer's phonemes.
 *
 * The backend is configurable via env vars:
 *
 *   BABBLE_TTS = auto (default) | piper | say | espeak
 *   PIPER_BIN    path to the piper binary           (default: "piper" on PATH)
 *   PIPER_MODEL  path to a piper .onnx voice model   (required to use piper)
 *   PIPER_SPEAKER  speaker id for multi-speaker models (optional)
 *
 * "auto" prefers the most natural engine available:
 *   1. piper    — neural, natural-sounding (needs a voice model)
 *   2. say      — macOS system voices
 *   3. espeak-ng — clear but robotic; works anywhere
 * A backend is resolved once and cached.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

// --- configuration -----------------------------------------------------------
const TTS_PREF = (process.env.BABBLE_TTS || 'auto').toLowerCase();
const PIPER_BIN = process.env.PIPER_BIN || 'piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '';
const PIPER_SPEAKER = process.env.PIPER_SPEAKER || '';

// --- phoneme -> readable spelling --------------------------------------------
// Both backends are driven by an English-ish spelling read as a pseudo-word,
// NOT by raw phoneme codes. macOS `say` ignores its `[[inpt PHON]]` command, and
// espeak-ng's Kirshenbaum `[[ ]]` mode silently drops some vowel sequences
// (e.g. "banana" came out as silence) — but both pronounce ordinary letters
// reliably and well. So we hand them a spelling and let the voice say it; the
// same word always renders the same way for the target and every guess.
const SPELL = {
  p: 'p', b: 'b', t: 't', d: 'd', k: 'k', g: 'g',
  ch: 'ch', j: 'j',
  f: 'f', v: 'v', th: 'th', dh: 'th', s: 's', z: 'z', sh: 'sh', zh: 'zh', h: 'h',
  m: 'm', n: 'n', ng: 'ng',
  l: 'l', r: 'r', w: 'w', y: 'y',
  a: 'ah', e: 'eh', i: 'ee', o: 'oh', u: 'oo', ə: 'uh',
};
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'ə']);

/**
 * Spelling for the synthesizer, e.g. [b,a,b,a] -> "bahbah", [m,o,a,p,u] -> "moh-ahpoo".
 * Hyphens between adjacent vowels keep a run from merging into one diphthong
 * (so [a,i] reads "ah-ee", not "ahee") and give the voice clean syllable breaks.
 */
function phonemesToSpelling(phonemes) {
  let out = '';
  let prevVowel = false;
  for (const p of phonemes) {
    const isVowel = VOWELS.has(p);
    if (isVowel && prevVowel) out += '-'; // break vowel runs into syllables
    out += SPELL[p] || '';
    prevVowel = isVowel;
  }
  return out;
}

// --- backend detection -------------------------------------------------------
function has(cmd) {
  // absolute/relative path: check it exists & is executable; bare name: search PATH
  if (cmd.includes('/')) {
    try { fss.accessSync(cmd, fss.constants.X_OK); return true; } catch (_) { return false; }
  }
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
const piperReady = () => !!PIPER_MODEL && fss.existsSync(PIPER_MODEL) && has(PIPER_BIN);
const espeakBin = () => (has('espeak-ng') ? 'espeak-ng' : has('espeak') ? 'espeak' : null);

let BACKEND = null; // 'piper' | 'say' | 'espeak' | 'none'
function backend() {
  if (BACKEND) return BACKEND;
  const pick = {
    piper: () => (piperReady() ? 'piper' : 'none'),
    say: () => (has('say') ? 'say' : 'none'),
    espeak: () => (espeakBin() ? 'espeak' : 'none'),
    auto: () =>
      piperReady() ? 'piper'
      : process.platform === 'darwin' && has('say') ? 'say'
      : espeakBin() ? 'espeak'
      : 'none',
  };
  BACKEND = (pick[TTS_PREF] || pick.auto)();
  return BACKEND;
}

function backendName() {
  const b = backend();
  if (b === 'piper') return `piper (${path.basename(PIPER_MODEL).replace(/\.onnx$/, '')})`;
  if (b === 'say') return 'macOS say';
  if (b === 'espeak') return 'espeak-ng';
  return 'none';
}

// --- rendering ---------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
  });
}
// run a command, feeding `input` on stdin (piper reads its text from stdin)
function runStdin(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { timeout: 15000 });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`))));
    p.stdin.on('error', () => {}); // ignore EPIPE if the child dies early
    p.stdin.end(input);
  });
}

async function renderToFile(phonemes, wpm) {
  const tmp = path.join(os.tmpdir(), `babble-${crypto.randomBytes(6).toString('hex')}.wav`);
  const b = backend();
  const text = phonemesToSpelling(phonemes);
  if (b === 'piper') {
    // piper has no wpm; length-scale stretches phonemes (1 = normal, >1 = slower)
    const lengthScale = (150 / wpm).toFixed(2);
    const args = ['-m', PIPER_MODEL, '-f', tmp, '--length-scale', lengthScale, '--sentence-silence', '0'];
    if (PIPER_SPEAKER) args.push('-s', PIPER_SPEAKER);
    await runStdin(PIPER_BIN, args, text);
  } else if (b === 'say') {
    await run('say', ['-o', tmp, '--data-format=LEI16@22050', '-r', String(wpm), text]);
  } else if (b === 'espeak') {
    // espeak speed is words/min; bias a touch slower for clarity.
    await run(espeakBin(), ['-w', tmp, '-s', String(wpm), '-p', '42', text]);
  } else {
    throw new Error('no TTS backend');
  }
  return tmp;
}

// Small cache so identical renders (e.g. repeated phonemes) are instant.
const cache = new Map();
const MAX_CACHE = 300;

/** synthPhonemes(phonemes, {wpm}) -> Buffer (WAV) | null for empty input. */
async function synthPhonemes(phonemes, { wpm = 150 } = {}) {
  if (!phonemes || !phonemes.length) return null;
  if (backend() === 'none') return null;
  const key = phonemes.join('.') + '|' + wpm;
  if (cache.has(key)) return cache.get(key);

  let tmp;
  try {
    tmp = await renderToFile(phonemes, wpm);
    const buf = await fs.readFile(tmp);
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(key, buf);
    return buf;
  } catch (e) {
    console.error('[tts] render failed:', e.message);
    return null;
  } finally {
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
}

/** Convenience: render straight to a base64 string ('' for empty/failed). */
async function synthPhonemesB64(phonemes, opts) {
  const buf = await synthPhonemes(phonemes, opts);
  return buf ? buf.toString('base64') : '';
}

module.exports = {
  phonemesToSpelling,
  synthPhonemes,
  synthPhonemesB64,
  backend,
  backendName,
};
