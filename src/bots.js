/**
 * bots.js — computer players of varying expertise for Babble.
 *
 * A bot can't "type" a guess, so instead of going through the text→phoneme
 * decoder it perturbs the round's hidden target phonemes directly: the higher
 * its skill, the more of the target it reproduces faithfully, so its phonetic
 * score lands higher. The Room scores a bot from these phonemes (and renders its
 * audio from them too), exactly mirroring how a human guess is scored — what you
 * hear at the reveal is what was judged.
 */
'use strict';

const { CONSONANTS, VOWELS, PH } = require('./phonetics');

// Five fixed expertise levels. `skill` ≈ the fraction of sounds a bot keeps
// intact; it was tuned (see test/bots.test.js) so the levels spread out across
// the 0–100 score range from "wild guesser" to "near-perfect".
const BOT_LEVELS = [
  { key: 'novice', name: 'Babbles',  avatar: '🐣', label: 'Novice', skill: 0.15 },
  { key: 'easy',   name: 'Echo',     avatar: '🐤', label: 'Easy',   skill: 0.33 },
  { key: 'medium', name: 'Mimi',     avatar: '🦜', label: 'Medium', skill: 0.55 },
  { key: 'hard',   name: 'Maestro',  avatar: '🦉', label: 'Hard',   skill: 0.75 },
  { key: 'expert', name: 'Polyglot', avatar: '🧠', label: 'Expert', skill: 0.92 },
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// A mishearing that stays in the same broad class (vowel↔vowel, cons↔cons) so
// the score degrades gracefully instead of collapsing to noise.
function nearPhoneme(ph) {
  const pool = PH[ph] && PH[ph].cat === 'vowel' ? VOWELS : CONSONANTS;
  let c = pick(pool);
  if (c === ph && pool.length > 1) c = pick(pool);
  return c;
}

// Build a guess (as a phoneme array) at the given skill.
function botGuessPhonemes(target, skill) {
  if (!target || !target.length) return ['a'];
  const out = [];
  for (const ph of target) {
    if (Math.random() < skill) { out.push(ph); continue; } // heard it right
    const e = Math.random();
    if (e < 0.55) out.push(nearPhoneme(ph));            // misheard a sound
    else if (e < 0.8) { /* dropped a sound */ }
    else { out.push(ph); out.push(nearPhoneme(ph)); }   // doubled up
  }
  // a low-skill bot occasionally fumbles an extra sound; never go empty
  if (out.length > 1 && Math.random() > skill && Math.random() < 0.4) {
    out.splice(Math.floor(Math.random() * out.length), 1);
  }
  if (!out.length) out.push(pick(target));
  return out;
}

// A compact, readable spelling so the reveal can show what the bot "wrote".
const SPELL = { a: 'a', e: 'e', i: 'ee', o: 'o', u: 'oo', ə: 'uh' };
function phonemesToWord(phs) {
  return phs.map((p) => SPELL[p] || p).join('') || 'hm';
}

module.exports = { BOT_LEVELS, botGuessPhonemes, phonemesToWord };
