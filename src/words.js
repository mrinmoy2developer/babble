/**
 * words.js — the "automated system that picks random words".
 *
 * A target is generated as a phoneme sequence (the ground-truth sound) plus a
 * spelling string + BCP-47 voice hint so the browser TTS can read it aloud.
 *
 * Sources:
 *   - gibberish: random phonotactically-plausible nonsense.
 *   - language packs: each defines its own phoneme inventory + syllable shapes
 *     so generated words *sound* like that language without being real (and
 *     therefore unguessable by vocabulary — you can only go by ear).
 */

'use strict';

const { phonemesToSpelling, CONSONANTS, VOWELS } = require('./phonetics');

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// A language pack restricts the inventory and syllable templates so output
// carries that language's "flavour". `voice` is a BCP-47 tag for the TTS layer.
const PACKS = {
  gibberish: {
    label: 'Gibberish',
    voice: 'en-US',
    onset: CONSONANTS,
    nucleus: VOWELS,
    coda: CONSONANTS.concat(['']),
    shapes: ['CV', 'CVC', 'CVCV', 'VCV', 'CVCVC'],
  },
  japanesque: {
    label: 'Japanesque',
    voice: 'ja-JP',
    onset: ['k', 'g', 's', 'z', 't', 'd', 'n', 'h', 'b', 'p', 'm', 'y', 'r', 'w', ''],
    nucleus: ['a', 'i', 'u', 'e', 'o'],
    coda: ['n', ''],
    shapes: ['CV', 'CVCV', 'CVCVCV', 'VCV'],
  },
  italiano: {
    label: 'Italianesque',
    voice: 'it-IT',
    onset: ['p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 's', 'm', 'n', 'l', 'r'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: ['', '', 'n', 'r', 'l'],
    shapes: ['CVCV', 'CVCVCV', 'VCV', 'CVCV'],
  },
  germanesque: {
    label: 'Germanesque',
    voice: 'de-DE',
    onset: ['sh', 'k', 'g', 't', 'd', 'b', 'f', 'v', 'ts', 'r', 'm', 'n', 'l'],
    nucleus: ['a', 'e', 'i', 'o', 'u', 'ə'],
    coda: ['n', 't', 'k', 'sh', 'r', ''],
    shapes: ['CVC', 'CVCVC', 'CVCC', 'CVC'],
  },
  banglaish: {
    label: 'Banglaesque',
    voice: 'bn-IN',
    onset: ['k', 'g', 'ch', 'j', 't', 'd', 'n', 'p', 'b', 'm', 'r', 'l', 'sh', 's', 'h'],
    nucleus: ['a', 'o', 'i', 'u', 'e', 'ə'],
    coda: ['', 'n', 'r', 'l', 'sh'],
    shapes: ['CVC', 'CVCV', 'CVCVC', 'VCV'],
  },
  espanol: {
    label: 'Spanishesque',
    voice: 'es-ES',
    onset: ['p', 'b', 't', 'd', 'k', 'g', 'f', 's', 'm', 'n', 'l', 'r', 'ch', 'j'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: ['', '', 's', 'n', 'r', 'l'],
    shapes: ['CV', 'CVCV', 'CVCVCV', 'CVCV'],
  },
  francais: {
    label: 'Frenchesque',
    voice: 'fr-FR',
    onset: ['s', 'sh', 'z', 'zh', 'f', 'v', 'p', 'b', 't', 'd', 'k', 'g', 'm', 'n', 'l', 'r'],
    nucleus: ['a', 'e', 'i', 'o', 'u', 'ə'],
    coda: ['', '', 'n', 'r'],
    shapes: ['CV', 'CVCV', 'VCV', 'CVC'],
  },
  russesque: {
    label: 'Russianesque',
    voice: 'ru-RU',
    onset: ['p', 'b', 't', 'd', 'k', 'g', 's', 'z', 'sh', 'zh', 'ch', 'v', 'f', 'm', 'n', 'l', 'r'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: ['', 'n', 't', 'k', 'sh', 'r', 'l'],
    shapes: ['CVC', 'CVCC', 'CVCVC', 'CVCV'],
  },
  arabesque: {
    label: 'Arabicesque',
    voice: 'ar-SA',
    onset: ['k', 'g', 'h', 's', 'z', 'sh', 'd', 't', 'b', 'm', 'n', 'l', 'r', 'w', 'y', 'f'],
    nucleus: ['a', 'i', 'u'],
    coda: ['', 'b', 'd', 'k', 'm', 'n', 'r', 'l', 's'],
    shapes: ['CVC', 'CVCVC', 'CVCV'],
  },
  polynesian: {
    label: 'Polynesianesque',
    voice: 'en-US',
    onset: ['p', 'k', 'h', 'm', 'n', 'l', 'w', '', ''],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: [''],
    shapes: ['CV', 'CVCV', 'CVCVCV', 'VCV', 'CVCVCV'],
  },
  koreanesque: {
    label: 'Koreanesque',
    voice: 'ko-KR',
    onset: ['k', 'g', 'n', 'd', 'r', 'm', 'b', 's', 'j', 'ch', 'h', ''],
    nucleus: ['a', 'e', 'i', 'o', 'u', 'ə'],
    coda: ['', 'k', 'n', 'ng', 'l', 'm', 'p', 't'],
    shapes: ['CVC', 'CVCVC', 'CVCV'],
  },
  hindesque: {
    label: 'Hindiesque',
    voice: 'hi-IN',
    onset: ['k', 'g', 'ch', 'j', 't', 'd', 'n', 'p', 'b', 'm', 'y', 'r', 'l', 'v', 's', 'h', 'sh'],
    nucleus: ['a', 'i', 'u', 'e', 'o', 'ə'],
    coda: ['', 'n', 'r', 'l'],
    shapes: ['CVCV', 'CVC', 'CVCVC'],
  },
  swahilesque: {
    label: 'Swahiliesque',
    voice: 'sw-KE',
    onset: ['m', 'n', 'b', 't', 'k', 'g', 's', 'sh', 'ch', 'j', 'v', 'f', 'l', 'r', 'w', 'y', 'h'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: [''],
    shapes: ['CV', 'CVCV', 'CVCVCV'],
  },
  hellenic: {
    label: 'Greekesque',
    voice: 'el-GR',
    onset: ['p', 't', 'k', 'f', 'th', 's', 'z', 'm', 'n', 'l', 'r', 'v', 'g', 'dh'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: ['', 's', 'n'],
    shapes: ['CVC', 'CVCV', 'CVCVC'],
  },
  turkic: {
    label: 'Turkishesque',
    voice: 'tr-TR',
    onset: ['k', 'g', 't', 'd', 'b', 'p', 's', 'sh', 'ch', 'j', 'm', 'n', 'l', 'r', 'y'],
    nucleus: ['a', 'e', 'i', 'o', 'u', 'ə'],
    coda: ['', 'k', 'n', 'l', 'r', 't'],
    shapes: ['CVC', 'CVCVC', 'CVCV'],
  },
  zhonghua: {
    label: 'Mandarinesque',
    voice: 'zh-CN',
    onset: ['p', 't', 'k', 'm', 'n', 'l', 's', 'sh', 'ch', 'j', 'h', 'w', 'y', 'f'],
    nucleus: ['a', 'e', 'i', 'o', 'u'],
    coda: ['', 'n', 'ng'],
    shapes: ['CV', 'CVC', 'CVCV'],
  },
  nordic: {
    label: 'Nordicesque',
    voice: 'sv-SE',
    onset: ['sh', 'k', 'g', 't', 'd', 'b', 'f', 'v', 's', 'h', 'm', 'n', 'l', 'r'],
    nucleus: ['a', 'e', 'i', 'o', 'u', 'ə'],
    coda: ['', 'r', 'n', 'k', 't', 'l', 'sh'],
    shapes: ['CVC', 'CVCC', 'CVCVC'],
  },
  elvish: {
    label: 'Elvish (fantasy)',
    voice: 'en-GB',
    onset: ['l', 'r', 'n', 'm', 'th', 's', 'f', 'v', 'g', 'd', 't'],
    nucleus: ['a', 'e', 'i', 'o'],
    coda: ['', 'l', 'r', 'n', 'th'],
    shapes: ['CVCV', 'VCV', 'CVCVCV', 'CVCV'],
  },
  orcish: {
    label: 'Orcish (fantasy)',
    voice: 'en-US',
    onset: ['g', 'k', 'r', 'd', 'b', 'z', 'th', 'sh'],
    nucleus: ['a', 'o', 'u'],
    coda: ['k', 'g', 'r', 'sh', 'z'],
    shapes: ['CVC', 'CVCC', 'CVCVC'],
  },
};

const SOURCE_KEYS = Object.keys(PACKS);

// 'ts' isn't in the core inventory; map cluster shorthands to real phonemes.
const CLUSTER = { ts: ['t', 's'] };

function pieces(symbol, pack) {
  if (symbol === '') return [];
  if (CLUSTER[symbol]) return CLUSTER[symbol];
  return [symbol];
}

function buildSyllable(shape, pack) {
  const phs = [];
  for (const slot of shape) {
    if (slot === 'C') phs.push(...pieces(pick(pack.onset), pack));
    else if (slot === 'V') phs.push(...pieces(pick(pack.nucleus), pack));
  }
  return phs;
}

/**
 * generateWord({ sources, difficulty }) -> {
 *   phonemes, spelling, voice, source, syllables
 * }
 * difficulty 1..5 scales how many syllables / phonemes the target has.
 */
function generateWord({ sources, difficulty = 2 } = {}) {
  const pool = (sources && sources.length ? sources : ['gibberish']).filter(
    (s) => PACKS[s]
  );
  const key = pick(pool.length ? pool : ['gibberish']);
  const pack = PACKS[key];

  const syllCount = Math.max(1, Math.min(6, randInt(difficulty, difficulty + 1)));
  let phonemes = [];
  let syllables = 0;
  let guard = 0;
  while (syllables < syllCount && guard++ < 20) {
    const shape = pick(pack.shapes);
    const syl = buildSyllable(shape, pack);
    if (syl.length) {
      phonemes.push(...syl);
      syllables++;
    }
  }
  if (!phonemes.length) phonemes = buildSyllable('CVC', pack);

  return {
    phonemes,
    spelling: phonemesToSpelling(phonemes),
    voice: pack.voice,
    source: pack.label,
    sourceKey: key,
    syllables,
  };
}

function listSources() {
  return SOURCE_KEYS.map((k) => ({ key: k, label: PACKS[k].label }));
}

module.exports = { generateWord, listSources, PACKS, SOURCE_KEYS };
