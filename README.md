# 🗣️ Babble

An online multiplayer browser game in the spirit of *skribbl.io* and *Garlic Phone* —
but the medium is **sound**, not drawing.

An automated engine picks a random word (from a real-ish language pack or pure
**gibberish**). Everyone **hears** it spoken aloud and can replay it as many times
as they like. You then **spell what you heard** in a common answer language
(English, Bengali, …). The game runs every guess through a **text‑to‑sound
decoder** and scores each player by how close their guess *sounds* to the
original. Closest sound wins.

```
engine → phonemes → 🔊 you hear it → ✍️ you spell it → 🔊 decoded → 📏 compared → 🏆
```

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL in two tabs (or share `http://<your-ip>:3000` on your LAN). One
player **Creates a room** and shares the 4‑letter code; others **Join**. The
host tweaks settings and hits **Start**.

### Audio

Speech is synthesized **on the server** from phonemes and streamed to players as
WAV, so everyone hears the same thing and the browser only has to play it:

- **macOS:** uses the built-in `say` engine (good-quality system voices) — works
  out of the box, nothing to install.
- **Linux / other:** install **espeak-ng** (`apt install espeak-ng` /
  `brew install espeak-ng`) and the server will use it automatically.

On boot the server prints which backend it found. No API keys, fully offline.
The synthesizer is driven by **phonemes**, not letters, so pronunciation is
clear and identical for the target word and every guess — which is exactly what
makes scoring fair. It's articulate rather than Hollywood-natural; for a
"spell-the-sound" game that accuracy is the point (and gibberish has no natural
reading anyway).

## How scoring works (the interesting bit)

Comparing raw audio waveforms in a browser is flaky, so Babble scores in a
language-neutral **phoneme** space instead — which is exactly what "compare the
sound" means:

1. **Targets are sounds, not spellings.** Each word is generated directly as a
   sequence of phonemes (`src/words.js`). Gibberish is random phonotactically
   plausible nonsense; language packs constrain the phoneme inventory and
   syllable shapes so output *sounds* Japanese / Italian / Bengali-ish without
   being a real, lookup-able word.
2. **You hear it.** The server renders those phonemes to audio (`src/tts.js`) and
   sends only the WAV — never the phonemes — so the answer can't be sniffed off
   the wire during play. Replay it as often as you like, or hit 🐢 for a slower
   take.
3. **The decoder** (`g2p` in `src/phonetics.js`) turns your typed guess back into
   phonemes — literally pronouncing your text. English, Bengali (Bangla script)
   and a romanized fallback are built in; add more by extending `DECODERS`.
4. **Comparison** is a weighted phonetic edit distance: swapping similar sounds
   (`b`↔`p`, `s`↔`z`, nearby vowels) costs little; swapping a vowel for a
   consonant costs a lot. The result maps to a **0–100** similarity score.

Because it scores *sound*, `banana`, `bananna`, and `bunana` all score near the
top — the letters differ but the pronunciation barely does.

At the **reveal** you get the whole picture: every player's guess in text, a
▶ button to **play each guess** (rendered from the exact phonemes it was scored
on), and a **waveform** of each guess overlaid on the original so you can *see*
how close it landed. All scoring happens on the server; clients never receive
the target phonemes until the reveal.

## Settings (host)

| Setting | Meaning |
|---|---|
| Word sources | Which of the **19 packs** the engine draws from — Gibberish, real-language flavours (Japanese, Italian, German, Bengali, Spanish, French, Russian, Arabic, Polynesian, Korean, Hindi, Swahili, Greek, Turkish, Mandarin, Nordic) and fantasy (Elvish, Orcish) |
| Answer language | Which decoder scores your guesses (English / Bengali / Spanish) |
| Rounds | 1–20 |
| Seconds / round | 10–180 |
| Reveal seconds | 5–60, how long results show before the next round |
| Difficulty | 1–5, scales word length (syllable count) |
| Public lobby | Public games are listed in the join-screen browser; private games are code-only |
| Waveform preview | Lets players see the original waveform and stack/compare their tries before submitting |

### During a game

- **HUD (top-right):** **?** help, **⏸ / ▶** pause-resume (host), **⏏** exit.
- **Lock-in alerts:** a toast + chime tells everyone when another player locks in.
- **Clock ticks** in the final 10 seconds (faster in the last 5).
- **Reveal:** the host can hit **Next round ▶** to skip the countdown.
- **Win:** confetti + a victory fanfare on the final standings.

All sound effects are synthesized in the browser (Web Audio) — no asset files.

## Project layout

```
server.js              Express static host + Socket.IO transport (thin)
src/phonetics.js       text→sound decoder (g2p) + sound comparison (score)
src/tts.js             server-side speech synth (macOS say / espeak-ng)
src/words.js           the automated word/gibberish generator
src/game.js            Room + round state machine (lobby → rounds → results)
public/                index.html · style.css · client.js (Web Audio playback + waveforms)
test/                  phonetics.test.js · tts.test.js (unit) · integration.test.js (e2e)
```

## Tests

```bash
npm test            # decoder + scoring + TTS + room-logic unit checks
npm run test:e2e    # boots a server: full round + pause/resume/lock/next/public-lobby
```

## Extending

- **A new language pack to hear:** add an entry to `PACKS` in `src/words.js`
  with its phoneme inventory, syllable `shapes`, and a BCP-47 `voice` tag.
- **A new answer language to spell in:** add a `g2p` function and register it in
  `DECODERS` in `src/phonetics.js`, plus an `<option>` in `index.html`.
- **Real (non-gibberish) words:** feed real phoneme transcriptions into a pack's
  generator instead of synthesizing syllables.

## Ideas / roadmap

- True audio comparison (MFCC + DTW on recorded TTS) as an optional scoring mode.
- Per-guess "warmer/colder" hints.
- Reconnect-by-token so a refresh rejoins your seat mid-game.
- Custom word lists / themed packs.

MIT.
