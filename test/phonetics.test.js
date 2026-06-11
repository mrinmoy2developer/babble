'use strict';
// Minimal assertions for the scoring engine — run with `npm test`.
const assert = require('assert');
const { g2p, score, englishG2P } = require('../src/phonetics');
const { generateWord } = require('../src/words');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('phonetics:');

// G2P sanity
const cat = englishG2P('cat');
ok('"cat" -> k a t', cat.join('') === 'kat');
ok('"ph" reads as f', englishG2P('phone')[0] === 'f');
ok('"sh" is one phoneme', englishG2P('ship')[0] === 'sh');

// identical text scores 100
const target = g2p('banana', 'en');
ok('identical guess scores 100', score(g2p('banana', 'en'), target) === 100);

// a doubled letter is the SAME sound -> still 100 (we score sound, not spelling)
ok('doubled consonant scores same as single', score(g2p('bananna', 'en'), target) === 100);

// a one-vowel-off guess scores high but < 100
const near = score(g2p('banano', 'en'), target);
ok('near miss is high (' + near + ')', near >= 80 && near < 100);

// homophone-ish spelling still scores very high (sound, not letters)
const homo = score(g2p('bunana', 'en'), target);
ok('different letters, similar sound stays high (' + homo + ')', homo >= 70);

// nonsense scores low
const far = score(g2p('xyz', 'en'), target);
ok('unrelated guess scores low (' + far + ')', far < 50);

// generator produces playable targets
const w = generateWord({ sources: ['gibberish'], difficulty: 2 });
ok('generated word has phonemes', Array.isArray(w.phonemes) && w.phonemes.length >= 2);
ok('generated word has a spelling', typeof w.spelling === 'string' && w.spelling.length > 0);

// scoring is symmetric
const a = g2p('hello', 'en');
const b = g2p('hallo', 'en');
ok('score is symmetric', score(a, b) === score(b, a));

console.log(`\n${passed} checks passed.`);
