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
 *
 *   # Piper (neural, natural — recommended). Voices are .onnx models in a folder.
 *   PIPER_VOICES_DIR  folder of *.onnx voice models   (enables piper + voice choice)
 *   PIPER_PY          python with piper-tts installed  (default: derived/python3)
 *   PIPER_DEFAULT_VOICE  voice id to use by default    (default: first found)
 *   PIPER_PORT        localhost port for the sidecar   (default: 5923)
 *   PIPER_MODEL       (legacy) a single .onnx file; its folder becomes the dir
 *
 * For piper we run a small persistent Python sidecar (scripts/piper_server.py)
 * that loads voice models ONCE and keeps them resident — warm synths are ~20ms
 * instead of reloading the ~0.5s model every word. The sidecar is spawned and
 * supervised here; players never see it.
 *
 * "auto" prefers the most natural engine available: piper -> say -> espeak.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

// --- configuration -----------------------------------------------------------
const TTS_PREF = (process.env.BABBLE_TTS || 'auto').toLowerCase();
const PIPER_MODEL = process.env.PIPER_MODEL || '';
const VOICES_DIR =
  process.env.PIPER_VOICES_DIR || (PIPER_MODEL ? path.dirname(PIPER_MODEL) : '');
const PIPER_PORT = parseInt(process.env.PIPER_PORT || '5923', 10);
const PIPER_DEFAULT_VOICE =
  process.env.PIPER_DEFAULT_VOICE ||
  (PIPER_MODEL ? path.basename(PIPER_MODEL).replace(/\.onnx$/, '') : '');
const PIPER_PY =
  process.env.PIPER_PY ||
  (process.env.PIPER_BIN ? path.join(path.dirname(process.env.PIPER_BIN), 'python') : 'python3');
const SIDECAR = path.join(__dirname, '..', 'scripts', 'piper_server.py');

// --- phoneme -> readable spelling --------------------------------------------
// Both the engines pronounce ordinary letters reliably (raw phoneme modes were
// flaky — espeak's `[[ ]]` even rendered some words silent). So we hand them a
// spelling and let the voice say it; the same word always renders identically.
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
 * Hyphens between adjacent vowels keep a run from merging into one diphthong and
 * give the voice clean syllable breaks.
 */
function phonemesToSpelling(phonemes) {
  let out = '';
  let prevVowel = false;
  for (const p of phonemes) {
    const isVowel = VOWELS.has(p);
    if (isVowel && prevVowel) out += '-';
    out += SPELL[p] || '';
    prevVowel = isVowel;
  }
  return out;
}

// --- voice discovery ---------------------------------------------------------
function has(cmd) {
  if (cmd.includes('/')) {
    try { fss.accessSync(cmd, fss.constants.X_OK); return true; } catch (_) { return false; }
  }
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

let _voices = null;
/** listVoices() -> [{id, label}] from the voices dir (cached). [] if none/no piper. */
function listVoices() {
  if (_voices) return _voices;
  _voices = [];
  if (backend() === 'piper' && VOICES_DIR) {
    try {
      for (const f of fss.readdirSync(VOICES_DIR)) {
        if (f.endsWith('.onnx')) {
          const id = f.replace(/\.onnx$/, '');
          _voices.push({ id, label: voiceLabel(id) });
        }
      }
    } catch (_) { /* dir unreadable */ }
    _voices.sort((a, b) => a.label.localeCompare(b.label));
  }
  return _voices;
}
function voiceLabel(id) {
  const [lang = '', name = id, q = ''] = id.split('-');
  const cap = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
  return `${cap}${lang ? ` · ${lang.replace('_', '-')}` : ''}${q ? ` (${q})` : ''}`;
}
function defaultVoice() {
  const ids = listVoices().map((v) => v.id);
  if (PIPER_DEFAULT_VOICE && ids.includes(PIPER_DEFAULT_VOICE)) return PIPER_DEFAULT_VOICE;
  return ids[0] || '';
}

// --- backend detection -------------------------------------------------------
const espeakBin = () => (has('espeak-ng') ? 'espeak-ng' : has('espeak') ? 'espeak' : null);
function piperReady() {
  if (!VOICES_DIR || !fss.existsSync(SIDECAR)) return false;
  let hasVoice = false;
  try { hasVoice = fss.readdirSync(VOICES_DIR).some((f) => f.endsWith('.onnx')); } catch (_) {}
  if (!hasVoice || !has(PIPER_PY)) return false;
  // confirm piper-tts is actually importable by that python (once, at boot)
  try { execFileSync(PIPER_PY, ['-c', 'import piper'], { stdio: 'ignore', timeout: 8000 }); return true; }
  catch (_) { return false; }
}

let BACKEND = null;
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
  if (b === 'piper') return `piper (${listVoices().length} voice${listVoices().length === 1 ? '' : 's'})`;
  if (b === 'say') return 'macOS say';
  if (b === 'espeak') return 'espeak-ng';
  return 'none';
}

// --- piper sidecar (persistent, keeps models resident) -----------------------
let sidecar = null; // { proc, ready: Promise<void> }
function startSidecar() {
  const args = [SIDECAR, '--voices-dir', VOICES_DIR, '--port', String(PIPER_PORT)];
  if (defaultVoice()) args.push('--preload', defaultVoice());
  const proc = spawn(PIPER_PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => console.error('[piper]', d.toString().trim()));
  proc.on('exit', (code) => {
    if (sidecar && sidecar.proc === proc) sidecar = null;
    if (code) console.error(`[piper] sidecar exited (${code}); will respawn on demand`);
  });
  sidecar = { proc, ready: waitForHealth(20000) };
  return sidecar;
}
async function ensureSidecar() {
  if (!sidecar) startSidecar();
  await sidecar.ready;
}
async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await httpReq('GET', '/health'); return; }
    catch (_) {
      if (Date.now() > deadline) throw new Error('piper sidecar did not become healthy');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
function httpReq(method, pathname, jsonBody) {
  return new Promise((resolve, reject) => {
    const body = jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : null;
    const req = http.request(
      { host: '127.0.0.1', port: PIPER_PORT, path: pathname, method, timeout: 15000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(buf);
          else reject(new Error(`piper ${res.statusCode}: ${buf.toString().slice(0, 160)}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('piper timeout')));
    req.end(body);
  });
}
async function synthPiper(text, lengthScale, voice) {
  const v = voice || defaultVoice();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureSidecar();
      return await httpReq('POST', '/synthesize', { voice: v, text, length_scale: lengthScale });
    } catch (e) {
      sidecar = null; // force respawn and retry once
      if (attempt === 1) throw e;
    }
  }
}

// clean up the child on shutdown
function killSidecar() { if (sidecar && sidecar.proc) try { sidecar.proc.kill(); } catch (_) {} }
process.on('exit', killSidecar);
process.on('SIGINT', () => { killSidecar(); process.exit(0); });
process.on('SIGTERM', () => { killSidecar(); process.exit(0); });

// --- CLI backends (say / espeak) --------------------------------------------
function runCli(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
  });
}
async function synthCli(b, text, wpm) {
  const tmp = path.join(os.tmpdir(), `babble-${crypto.randomBytes(6).toString('hex')}.wav`);
  try {
    if (b === 'say') {
      await runCli('say', ['-o', tmp, '--data-format=LEI16@22050', '-r', String(wpm), text]);
    } else {
      await runCli(espeakBin(), ['-w', tmp, '-s', String(wpm), '-p', '42', text]);
    }
    return await fs.readFile(tmp);
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// --- public synthesis --------------------------------------------------------
const cache = new Map();
const MAX_CACHE = 400;

/** synthPhonemes(phonemes, {wpm, voice}) -> Buffer (WAV) | null for empty/none. */
async function synthPhonemes(phonemes, { wpm = 150, voice = '' } = {}) {
  if (!phonemes || !phonemes.length) return null;
  const b = backend();
  if (b === 'none') return null;
  const v = b === 'piper' ? voice || defaultVoice() : '';
  const key = `${b}|${v}|${wpm}|${phonemes.join('.')}`;
  if (cache.has(key)) return cache.get(key);

  let buf = null;
  try {
    const text = phonemesToSpelling(phonemes);
    if (b === 'piper') buf = await synthPiper(text, +(150 / wpm).toFixed(2), v);
    else buf = await synthCli(b, text, wpm);
  } catch (e) {
    console.error('[tts] render failed:', e.message);
    return null;
  }
  if (buf) {
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(key, buf);
  }
  return buf;
}

/** Convenience: render straight to a base64 string ('' for empty/failed). */
async function synthPhonemesB64(phonemes, opts) {
  const buf = await synthPhonemes(phonemes, opts);
  return buf ? buf.toString('base64') : '';
}

/**
 * Spin up the piper sidecar and load the default voice at boot, so the first
 * round doesn't eat the one-time model-load delay. No-op for other backends.
 */
async function warmup() {
  if (backend() !== 'piper') return;
  try { await synthPhonemes(['b', 'a'], {}); } catch (_) { /* sidecar will retry on demand */ }
}

module.exports = {
  phonemesToSpelling,
  synthPhonemes,
  synthPhonemesB64,
  backend,
  backendName,
  listVoices,
  defaultVoice,
  warmup,
};
