'use strict';
// Bots: guesses are valid + non-empty, and skill maps monotonically to score so
// the five expertise levels genuinely play differently.
const assert = require('assert');
const { BOT_LEVELS, botGuessPhonemes, phonemesToWord } = require('../src/bots');
const { score } = require('../src/phonetics');
const { generateWord } = require('../src/words');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

console.log('bots:');

ok('there are five expertise levels', BOT_LEVELS.length === 5);
ok('skills are strictly increasing', BOT_LEVELS.every((l, i) => i === 0 || l.skill > BOT_LEVELS[i - 1].skill));

// average score per level over many random words
const N = 300;
const avgFor = (skill) => {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const w = generateWord({ sources: ['gibberish', 'japanesque', 'italiano'], difficulty: 2 + (i % 2) });
    const g = botGuessPhonemes(w.phonemes, skill);
    assert.ok(g.length > 0, 'bot guess is never empty');
    assert.ok(phonemesToWord(g).length > 0, 'bot guess renders to a word');
    sum += score(g, w.phonemes);
  }
  return sum / N;
};
const avgs = BOT_LEVELS.map((l) => avgFor(l.skill));
console.log('  · level averages:', avgs.map((a) => a.toFixed(0)).join(' < '));
ok('higher skill scores higher on average', avgs.every((a, i) => i === 0 || a > avgs[i - 1] + 3));
ok('novice is a weak player (< 55 avg)', avgs[0] < 55);
ok('expert is a strong player (> 85 avg)', avgs[avgs.length - 1] > 85);

console.log(`\n${passed} checks passed.`);
