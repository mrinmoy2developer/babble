/**
 * phonetics.js — the "text-to-sound decoder" and sound-comparison engine.
 *
 * Everything in Babble is scored in a small, language-neutral phoneme alphabet.
 * A "word" (whether a real foreign word or pure gibberish) is fundamentally a
 * sequence of these phonemes — that is the ground-truth *sound*.
 *
 *   - g2p(text, lang)      : grapheme -> phoneme. Decodes typed text into the
 *                            sound it would be pronounced as. This is the
 *                            "text to sound decoder".
 *   - phonemesToSpelling() : phoneme -> a spelling a TTS voice will read aloud
 *                            so humans can actually *hear* the target.
 *   - score(guessPh, tgtPh): phonetic edit distance -> 0..100 similarity. This
 *                            is "compare the sound".
 */

'use strict';

// ---------------------------------------------------------------------------
// Phoneme inventory + articulatory features
// ---------------------------------------------------------------------------
// Each phoneme has a broad CATEGORY plus light features so that similar sounds
// cost little to swap (b<->p) and dissimilar sounds cost a lot (b<->i).

const PH = {
  // stops
  p:  { cat: 'stop', voiced: false, place: 'labial' },
  b:  { cat: 'stop', voiced: true,  place: 'labial' },
  t:  { cat: 'stop', voiced: false, place: 'alveolar' },
  d:  { cat: 'stop', voiced: true,  place: 'alveolar' },
  k:  { cat: 'stop', voiced: false, place: 'velar' },
  g:  { cat: 'stop', voiced: true,  place: 'velar' },
  // affricates (treated near-stop/fricative)
  ch: { cat: 'affricate', voiced: false, place: 'palatal' },
  j:  { cat: 'affricate', voiced: true,  place: 'palatal' },
  // fricatives
  f:  { cat: 'fricative', voiced: false, place: 'labial' },
  v:  { cat: 'fricative', voiced: true,  place: 'labial' },
  th: { cat: 'fricative', voiced: false, place: 'dental' },
  dh: { cat: 'fricative', voiced: true,  place: 'dental' },
  s:  { cat: 'fricative', voiced: false, place: 'alveolar' },
  z:  { cat: 'fricative', voiced: true,  place: 'alveolar' },
  sh: { cat: 'fricative', voiced: false, place: 'palatal' },
  zh: { cat: 'fricative', voiced: true,  place: 'palatal' },
  h:  { cat: 'fricative', voiced: false, place: 'glottal' },
  // nasals
  m:  { cat: 'nasal', voiced: true, place: 'labial' },
  n:  { cat: 'nasal', voiced: true, place: 'alveolar' },
  ng: { cat: 'nasal', voiced: true, place: 'velar' },
  // approximants / liquids
  l:  { cat: 'approx', voiced: true, place: 'alveolar' },
  r:  { cat: 'approx', voiced: true, place: 'alveolar' },
  w:  { cat: 'approx', voiced: true, place: 'labial' },
  y:  { cat: 'approx', voiced: true, place: 'palatal' },
  // vowels (height 1=low..3=high, back: 0 front..2 back)
  a:  { cat: 'vowel', height: 1, back: 1 }, // "ah"
  e:  { cat: 'vowel', height: 2, back: 0 }, // "eh"
  i:  { cat: 'vowel', height: 3, back: 0 }, // "ee"
  o:  { cat: 'vowel', height: 2, back: 2 }, // "oh"
  u:  { cat: 'vowel', height: 3, back: 2 }, // "oo"
  ə:  { cat: 'vowel', height: 2, back: 1 }, // schwa "uh"
};

const ALL_PHONEMES = Object.keys(PH);
const CONSONANTS = ALL_PHONEMES.filter((p) => PH[p].cat !== 'vowel');
const VOWELS = ALL_PHONEMES.filter((p) => PH[p].cat === 'vowel');

// ---------------------------------------------------------------------------
// Substitution cost between two phonemes (0 = identical, 1 = maximally different)
// ---------------------------------------------------------------------------
function subCost(a, b) {
  if (a === b) return 0;
  const A = PH[a];
  const B = PH[b];
  if (!A || !B) return 1;

  const aVowel = A.cat === 'vowel';
  const bVowel = B.cat === 'vowel';

  // vowel vs consonant: very different sounds
  if (aVowel !== bVowel) return 1;

  if (aVowel && bVowel) {
    // distance in the height/back grid, normalised to ~0.2..0.8
    const dh = Math.abs(A.height - B.height); // 0..2
    const db = Math.abs(A.back - B.back); // 0..2
    return Math.min(0.85, 0.2 + (dh + db) * 0.18);
  }

  // both consonants
  let cost = 0;
  if (A.cat !== B.cat) cost += 0.45; // different manner
  if (A.place !== B.place) cost += 0.3; // different place
  if (A.voiced !== B.voiced) cost += 0.2; // voicing only
  return Math.min(1, cost || 0.15);
}

const GAP = 0.9; // cost of an inserted/deleted phoneme

// ---------------------------------------------------------------------------
// Weighted Levenshtein over phoneme arrays
// ---------------------------------------------------------------------------
function phoneticDistance(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m * GAP;
  if (m === 0) return n * GAP;

  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j * GAP;

  for (let i = 1; i <= n; i++) {
    curr[0] = i * GAP;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + subCost(a[i - 1], b[j - 1]);
      const del = prev[j] + GAP;
      const ins = curr[j - 1] + GAP;
      curr[j] = Math.min(sub, del, ins);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * score(guessPhonemes, targetPhonemes) -> integer 0..100
 * 100 = phonetically identical, 0 = nothing alike.
 */
function score(guess, target) {
  if (!guess.length && !target.length) return 100;
  const dist = phoneticDistance(guess, target);
  const worst = Math.max(guess.length, target.length) * GAP || 1;
  const sim = 1 - dist / worst;
  return Math.max(0, Math.min(100, Math.round(sim * 100)));
}

// ---------------------------------------------------------------------------
// Grapheme -> Phoneme  ("text to sound decoder")
// ---------------------------------------------------------------------------
// Rule-based, digraph-aware. Designed to be "good enough" and fair: both the
// target and the guess go through the same decoder, so consistency matters more
// than perfect linguistic accuracy. New answer languages slot in here.

// Multi-letter graphemes are matched before single letters.
const EN_DIGRAPHS = [
  ['tch', ['ch']],
  ['sch', ['sh']],
  ['shh', ['sh']],
  ['ng', ['ng']],
  ['sh', ['sh']],
  ['ch', ['ch']],
  ['th', ['th']],
  ['ph', ['f']],
  ['gh', ['g']],
  ['ck', ['k']],
  ['qu', ['k', 'w']],
  ['wh', ['w']],
  ['zh', ['zh']],
  ['oo', ['u']],
  ['ee', ['i']],
  ['ea', ['i']],
  ['ai', ['e', 'i']],
  ['ay', ['e', 'i']],
  ['ou', ['a', 'u']],
  ['ow', ['a', 'u']],
  ['oa', ['o']],
  ['oi', ['o', 'i']],
  ['oy', ['o', 'i']],
  ['au', ['a']],
  ['aw', ['a']],
  ['ie', ['a', 'i']],
];

const EN_SINGLE = {
  a: ['a'], b: ['b'], c: ['k'], d: ['d'], e: ['e'], f: ['f'], g: ['g'],
  h: ['h'], i: ['i'], j: ['j'], k: ['k'], l: ['l'], m: ['m'], n: ['n'],
  o: ['o'], p: ['p'], q: ['k'], r: ['r'], s: ['s'], t: ['t'], u: ['u'],
  v: ['v'], w: ['w'], x: ['k', 's'], y: ['y'], z: ['z'],
};

function englishG2P(text) {
  const s = text.toLowerCase().replace(/[^a-z]/g, '');
  const out = [];
  let i = 0;
  outer: while (i < s.length) {
    for (const [graph, phs] of EN_DIGRAPHS) {
      if (s.startsWith(graph, i)) {
        out.push(...phs);
        i += graph.length;
        continue outer;
      }
    }
    const ch = s[i];
    // silent trailing 'e' (e.g. "cake" -> k a k, not k a k e)
    if (ch === 'e' && i === s.length - 1 && out.length > 2) {
      i += 1;
      continue;
    }
    if (EN_SINGLE[ch]) out.push(...EN_SINGLE[ch]);
    i += 1;
  }
  return collapse(out);
}

// Romanised fallback decoder for languages we don't have explicit rules for.
// Most Latin/transliterated input reads close enough phoneme-by-phoneme.
function romanizedG2P(text) {
  return englishG2P(text);
}

// Bengali (Bangla script) -> phonemes. Covers the common vowels/consonants and
// the inherent-vowel behaviour just enough to score guesses fairly.
const BN_MAP = {
  'অ': ['o'], 'আ': ['a'], 'ই': ['i'], 'ঈ': ['i'], 'উ': ['u'], 'ঊ': ['u'],
  'এ': ['e'], 'ঐ': ['o', 'i'], 'ও': ['o'], 'ঔ': ['o', 'u'],
  'ক': ['k', 'ə'], 'খ': ['k', 'ə'], 'গ': ['g', 'ə'], 'ঘ': ['g', 'ə'], 'ঙ': ['ng'],
  'চ': ['ch', 'ə'], 'ছ': ['ch', 'ə'], 'জ': ['j', 'ə'], 'ঝ': ['j', 'ə'], 'ঞ': ['n'],
  'ট': ['t', 'ə'], 'ঠ': ['t', 'ə'], 'ড': ['d', 'ə'], 'ঢ': ['d', 'ə'], 'ণ': ['n', 'ə'],
  'ত': ['t', 'ə'], 'থ': ['t', 'ə'], 'দ': ['d', 'ə'], 'ধ': ['d', 'ə'], 'ন': ['n', 'ə'],
  'প': ['p', 'ə'], 'ফ': ['f', 'ə'], 'ব': ['b', 'ə'], 'ভ': ['v', 'ə'], 'ম': ['m', 'ə'],
  'য': ['j', 'ə'], 'র': ['r', 'ə'], 'ল': ['l', 'ə'], 'শ': ['sh', 'ə'], 'ষ': ['sh', 'ə'],
  'স': ['s', 'ə'], 'হ': ['h', 'ə'], 'ড়': ['r', 'ə'], 'ঢ়': ['r', 'ə'], 'য়': ['y', 'ə'],
  // vowel signs (matras) — override the inherent vowel of the preceding consonant
  'া': ['a'], 'ি': ['i'], 'ী': ['i'], 'ু': ['u'], 'ূ': ['u'],
  'ে': ['e'], 'ৈ': ['o', 'i'], 'ো': ['o'], 'ৌ': ['o', 'u'],
  '্': ['VIRAMA'],
};

function banglaG2P(text) {
  const out = [];
  for (const ch of text) {
    const mapped = BN_MAP[ch];
    if (!mapped) continue;
    if (mapped[0] === 'VIRAMA') {
      // hasanta: strip the inherent vowel just added
      if (out.length && out[out.length - 1] === 'ə') out.pop();
      continue;
    }
    // a matra replaces the inherent 'ə' of the consonant before it
    const isMatra = 'ািীুূেৈোৌ'.includes(ch);
    if (isMatra && out.length && out[out.length - 1] === 'ə') out.pop();
    out.push(...mapped);
  }
  return collapse(out);
}

// Which script a character belongs to, so a mixed-script guess can be decoded
// run-by-run with the right rules (e.g. "টেস্টtest" -> bengali run + latin run).
function scriptOf(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x0980 && c <= 0x09ff) return 'bn'; // Bengali block
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 'en'; // Latin
  return 'other';
}

/**
 * Decode a guess that mixes scripts (e.g. Bengali + English). Each maximal
 * same-script run is decoded with its own rules, then concatenated.
 * Note: hanzi/CJK have no spelling-to-sound rule here and are skipped.
 */
function mixedG2P(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const s = scriptOf(text[i]);
    if (s === 'other') { i++; continue; }
    let j = i;
    while (j < text.length && scriptOf(text[j]) === s) j++;
    const run = text.slice(i, j);
    out.push(...(s === 'bn' ? banglaG2P(run) : englishG2P(run)));
    i = j;
  }
  return collapse(out);
}

const DECODERS = {
  en: englishG2P,
  english: englishG2P,
  bn: banglaG2P,
  bengali: banglaG2P,
  es: romanizedG2P,
  spanish: romanizedG2P,
  mixed: mixedG2P,
  default: romanizedG2P,
};

/** g2p(text, lang) — public entry to the text-to-sound decoder. */
function g2p(text, lang = 'en') {
  if (!text) return [];
  const fn = DECODERS[String(lang).toLowerCase()] || DECODERS.default;
  return fn(text);
}

// Drop accidental immediate duplicates and validate symbols.
function collapse(phs) {
  const out = [];
  for (const p of phs) {
    if (!PH[p]) continue;
    if (out.length && out[out.length - 1] === p && PH[p].cat !== 'vowel') continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phoneme -> spelling that a (chosen) TTS voice will read aloud
// ---------------------------------------------------------------------------
// We bias toward an English-reading voice by default; per-language tweaks make
// the synthesizer land closer to the intended sound.
const SPELL_EN = {
  p: 'p', b: 'b', t: 't', d: 'd', k: 'k', g: 'g', ch: 'ch', j: 'j',
  f: 'f', v: 'v', th: 'th', dh: 'th', s: 's', z: 'z', sh: 'sh', zh: 'zh',
  h: 'h', m: 'm', n: 'n', ng: 'ng', l: 'l', r: 'r', w: 'w', y: 'y',
  a: 'ah', e: 'eh', i: 'ee', o: 'oh', u: 'oo', ə: 'uh',
};

/**
 * phonemesToSpelling(phonemes) -> a string for SpeechSynthesisUtterance.
 * Inserts light separators so the voice articulates each syllable.
 */
function phonemesToSpelling(phonemes) {
  let s = '';
  for (let i = 0; i < phonemes.length; i++) {
    const p = phonemes[i];
    s += SPELL_EN[p] || '';
    // nudge a hyphen between a vowel and a following consonant cluster start
    const next = phonemes[i + 1];
    if (next && PH[p] && PH[next] && PH[p].cat === 'vowel' && PH[next].cat !== 'vowel') {
      // keep simple CVC together, only break on longer runs handled by caller
    }
  }
  return s;
}

module.exports = {
  PH,
  ALL_PHONEMES,
  CONSONANTS,
  VOWELS,
  subCost,
  phoneticDistance,
  score,
  g2p,
  englishG2P,
  banglaG2P,
  phonemesToSpelling,
  DECODERS,
};
