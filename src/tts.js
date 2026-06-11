/**
 * tts.js — server-side speech synthesis.
 *
 * Every sound in Babble is a phoneme sequence, so we drive the synthesizer with
 * phoneme input rather than letters. That gives clear, *consistent*
 * pronunciation: the exact phonemes we score against are the exact phonemes you
 * hear — for the target word and for every guess.
 *
 * Rendering on the server (not the browser) also means the round payload carries
 * only audio, never the answer's phonemes, so the word can't be sniffed off the
 * wire during play.
 *
 * Backends, in order of preference:
 *   1. macOS `say`  — high-quality system voices, Apple phoneme input.
 *   2. `espeak-ng`  — cross-platform, Kirshenbaum phoneme input.
 * A backend is detected once at startup.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

// --- phoneme symbol maps -----------------------------------------------------
// our internal phoneme -> English-ish spelling that `say` reads naturally as a
// pseudo-word. (macOS `say` ignores the `[[inpt PHON]]` phoneme command, but it
// pronounces ordinary text beautifully — so we hand it a readable spelling and
// let a real voice say it. Gibberish then sounds like a plausible foreign word.)
const SAY_SPELL = {
  p: 'p', b: 'b', t: 't', d: 'd', k: 'k', g: 'g',
  ch: 'ch', j: 'j',
  f: 'f', v: 'v', th: 'th', dh: 'th', s: 's', z: 'z', sh: 'sh', zh: 'zh', h: 'h',
  m: 'm', n: 'n', ng: 'ng',
  l: 'l', r: 'r', w: 'w', y: 'y',
  a: 'ah', e: 'eh', i: 'ee', o: 'oh', u: 'oo', ə: 'uh',
};
// our internal phoneme -> Kirshenbaum (espeak-ng `[[ ]]`)
const KIRS = {
  p: 'p', b: 'b', t: 't', d: 'd', k: 'k', g: 'g',
  ch: 'tS', j: 'dZ',
  f: 'f', v: 'v', th: 'T', dh: 'D', s: 's', z: 'z', sh: 'S', zh: 'Z', h: 'h',
  m: 'm', n: 'n', ng: 'N',
  l: 'l', r: 'r', w: 'w', y: 'j',
  a: 'A', e: 'E', i: 'i', o: 'O', u: 'u', ə: '@',
};
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'ə']);

/**
 * Spelling for `say`, e.g. [b,a,b,a] -> "bah-bah".
 * Hyphens between syllables keep adjacent vowels from merging into one diphthong
 * (so [a,i] reads "ah-ee", not "ahee") and give the voice clean syllable breaks.
 */
function phonemesToSaySpelling(phonemes) {
  let out = '';
  let prevVowel = false;
  for (const p of phonemes) {
    const isVowel = VOWELS.has(p);
    if (isVowel && prevVowel) out += '-'; // break vowel runs into syllables
    out += SAY_SPELL[p] || '';
    prevVowel = isVowel;
  }
  return out;
}

/** espeak Kirshenbaum string, e.g. [b,a,b,a] -> "[[b'AbA]]". */
function phonemesToEspeak(phonemes) {
  const firstVowel = phonemes.findIndex((p) => VOWELS.has(p));
  let body = '';
  phonemes.forEach((p, i) => {
    if (i === firstVowel) body += "'";
    body += KIRS[p] || '';
  });
  return '[[' + body + ']]';
}

// --- backend detection -------------------------------------------------------
function has(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

let BACKEND = null; // 'say' | 'espeak' | 'none'
function backend() {
  if (BACKEND) return BACKEND;
  if (process.platform === 'darwin' && has('say')) BACKEND = 'say';
  else if (has('espeak-ng')) BACKEND = 'espeak';
  else if (has('espeak')) BACKEND = 'espeak';
  else BACKEND = 'none';
  return BACKEND;
}

function backendName() {
  const b = backend();
  return b === 'say' ? 'macOS say' : b === 'espeak' ? 'espeak-ng' : 'none';
}

// --- rendering ---------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function renderToFile(phonemes, wpm) {
  const tmp = path.join(os.tmpdir(), `babble-${crypto.randomBytes(6).toString('hex')}.wav`);
  const b = backend();
  if (b === 'say') {
    const text = phonemesToSaySpelling(phonemes);
    await run('say', ['-o', tmp, '--data-format=LEI16@22050', '-r', String(wpm), text]);
  } else if (b === 'espeak') {
    const espeakBin = has('espeak-ng') ? 'espeak-ng' : 'espeak';
    await run(espeakBin, ['-w', tmp, '-s', String(wpm), '-p', '42', phonemesToEspeak(phonemes)]);
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
  phonemesToSaySpelling,
  phonemesToEspeak,
  synthPhonemes,
  synthPhonemesB64,
  backend,
  backendName,
};
