'use strict';
/**
 * make-runes.js — writes the Babble "alien alphabet" avatar glyphs as SVG files.
 *
 * Each glyph is hand-designed (not random) in one coherent style: a uniform
 * stroke weight, round caps/joins, and a shared vocabulary of stems, bowls,
 * hooks, enclosed forms and diacritic dots — so the set reads like a real
 * constructed script. They're drawn monochrome on a transparent background so
 * the client can tint them to any colour with a CSS mask.
 *
 * Run:  node assets/make-runes.js   ->  public/assets/runes/r00.svg …
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'assets', 'runes');
const SW = 8; // stroke width

// d: main stroke path; dots: filled diacritic nodes [[x,y],…] on a 0..100 canvas
const GLYPHS = [
  { d: 'M36 18 L36 84 M36 24 C 68 20 70 50 38 50', dots: [[58, 70]] },          // bowl-stem
  { d: 'M30 56 C 30 22 70 22 70 56 M50 38 L50 84' },                            // arch + drop
  { d: 'M68 24 C 36 18 34 48 50 52 C 66 56 64 84 32 80' },                      // flowing S
  { d: 'M40 18 L40 84 M40 50 C 70 48 72 80 42 82', dots: [[58, 28]] },          // stem + low bowl
  { d: 'M30 30 C 50 16 70 30 70 30 M50 22 L50 84 M34 58 L66 58' },              // crowned stem
  { d: 'M66 24 C 30 24 30 80 66 80 M34 52 L56 52', dots: [[64, 52]] },          // C with tongue
  { d: 'M50 22 C 28 22 28 54 50 54 C 72 54 72 22 50 22 M50 54 L50 84' },        // ring + stem
  { d: 'M50 28 L50 84 M30 40 C 40 28 40 28 50 30 M70 40 C 60 28 60 28 50 30 M34 70 L66 70' }, // trident
  { d: 'M36 18 L36 84 M36 20 C 64 24 64 44 36 48 M50 48 C 66 52 66 78 38 82' }, // double bowl
  { d: 'M34 84 L34 34 C 34 20 56 20 56 34', dots: [[58, 60]] },                 // hook J
  { d: 'M62 44 C 62 30 40 30 40 46 C 40 64 66 64 66 42 C 66 18 32 18 32 48 C 32 76 72 76 72 46' }, // spiral
  { d: 'M40 18 L40 84 M40 36 L66 20 M40 56 L66 84', dots: [[26, 50]] },         // runic stem
  { d: 'M68 24 C 28 24 28 80 68 80 M30 52 L52 52', dots: [[62, 52]] },          // big C
  { d: 'M50 18 L50 84 M30 42 C 44 30 56 30 70 42 M30 66 C 44 54 56 54 70 66' }, // winged stem
  { d: 'M26 50 C 40 30 60 30 74 50 C 60 70 40 70 26 50 Z M50 34 L50 66' },      // lens + bar
  { d: 'M36 20 C 36 46 64 46 64 20 M50 46 L50 84 M34 84 L66 84' },              // anchor
  { d: 'M50 18 L74 32 L74 64 L50 84 L26 64 L26 32 Z M50 40 L50 64' },           // hexagon + mark
  { d: 'M52 20 C 30 30 30 48 52 50 C 74 52 74 70 52 82 M30 82 L72 82' },        // wave on base
  { d: 'M34 20 C 52 40 52 60 34 80 M66 20 C 48 40 48 60 66 80', dots: [[50, 50]] }, // facing curves
  { d: 'M34 18 L34 60 C 34 80 62 80 62 58 C 62 44 44 44 44 58', dots: [[66, 26]] }, // crook + loop
  { d: 'M28 26 L72 26 M50 26 L50 66 M32 66 C 50 88 50 88 68 66' },              // T curved base
  { d: 'M50 18 L50 84 M50 34 C 26 38 26 62 50 58 M50 34 C 74 38 74 62 50 58' }, // leaf stem
  { d: 'M32 22 L66 22 L34 52 L66 52 L34 82 L66 82' },                          // zigzag
  { d: 'M30 32 C 50 18 70 30 70 52 C 70 76 38 80 32 58', dots: [[24, 42]] },    // sweep + dot
];

// Drawn in white on a transparent ground so the file works whether the browser
// treats a CSS mask as alpha- or luminance-based (white => fully shown in both).
function svg(g) {
  const dots = (g.dots || [])
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${SW * 0.72}" fill="#fff"/>`)
    .join('');
  // explicit width/height give the file an intrinsic size, which CSS `mask-size`
  // needs to scale it correctly (an `<img>` works without it, a mask does not)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">` +
    `<path d="${g.d}" fill="none" stroke="#fff" stroke-width="${SW}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
}

fs.mkdirSync(OUT, { recursive: true });
GLYPHS.forEach((g, i) => {
  fs.writeFileSync(path.join(OUT, `r${String(i).padStart(2, '0')}.svg`), svg(g));
});
console.log(`wrote ${GLYPHS.length} rune glyphs to ${OUT}`);
module.exports = { COUNT: GLYPHS.length };
