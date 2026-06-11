'use strict';
// Checks the phoneme->espeak mapping and that synthesis yields real WAV bytes.
const assert = require('assert');
const { phonemesToEspeak, phonemesToSaySpelling, synthPhonemes } = require('../src/tts');

// Peak |sample| of a 16-bit PCM WAV (walks chunks to find `data`).
function peakAmplitude(wav) {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.slice(off, off + 4).toString();
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') {
      let peak = 0;
      for (let i = 0; i < size >> 1; i++) {
        const s = Math.abs(wav.readInt16LE(off + 8 + i * 2));
        if (s > peak) peak = s;
      }
      return peak;
    }
    off += 8 + size + (size & 1);
  }
  return 0;
}

(async () => {
  let passed = 0;
  const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

  console.log('tts:');
  ok('maps phonemes to stressed Kirshenbaum (espeak)',
    phonemesToEspeak(['b', 'a', 'b', 'a']) === "[[b'AbA]]");
  ok('stress lands on first vowel only (espeak)',
    phonemesToEspeak(['s', 't', 'i']) === "[[st'i]]");
  ok('maps phonemes to a readable spelling (say)',
    phonemesToSaySpelling(['b', 'a', 'b', 'a']) === 'bahbah');
  ok('breaks vowel runs into syllables (say)',
    phonemesToSaySpelling(['m', 'o', 'a', 'p', 'u']) === 'moh-ahpoo');

  const wav = await synthPhonemes(['b', 'a', 'b', 'a']);
  ok('synthesis returns a Buffer', Buffer.isBuffer(wav));
  ok('output is a RIFF/WAVE container',
    wav.slice(0, 4).toString() === 'RIFF' && wav.slice(8, 12).toString() === 'WAVE');
  ok('non-trivial audio length', wav.length > 1000);

  // peak amplitude > 0: guards against a backend that emits a valid-sized but
  // SILENT wav (a real failure mode we hit and must never ship).
  ok('audio is actually audible (non-zero peak)', peakAmplitude(wav) > 500);

  const empty = await synthPhonemes([]);
  ok('empty phonemes -> null (silence)', empty === null);

  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
