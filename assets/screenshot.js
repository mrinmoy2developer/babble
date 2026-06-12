/* Capture real PNG screenshots of the app by driving a live 2-player game.
 *
 * One-time setup (Playwright isn't a runtime dependency):
 *     npm i -D playwright && npx playwright install chromium
 * Then:
 *     node assets/screenshot.js
 * Outputs into assets/screenshots/  (intro, lobby, play, reveal, gameover).
 *
 * Works on macOS (say) or Linux with espeak-ng installed; audio is irrelevant
 * to the captures, so it's fine if the TTS backend is "none".
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3097;
const URL = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Playwright not installed. Run:\n  npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  await wait(900);

  const browser = await chromium.launch();
  const viewport = { width: 920, height: 860 };
  const host = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const guest = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const hp = await host.newPage();
  const gp = await guest.newPage();

  const shot = (page, name, full = true) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  // set a range slider and fire the events the UI listens for
  const setRange = (page, id, val) => page.$eval(`#${id}`, (el, v) => {
    el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
  }, val);

  await hp.goto(URL);
  await hp.waitForSelector('#btn-enter');
  await wait(1700); // let the intro animation settle
  await shot(hp, '1-intro', false);

  await hp.click('#btn-enter');
  await hp.fill('#name-input', 'Ada');
  await hp.click('#btn-create');
  await hp.waitForSelector('#screen-lobby.active');

  // make it a single short round so we reach every screen quickly
  await setRange(hp, 'rounds', 1);
  await setRange(hp, 'secs', 60);
  // pick a few colourful packs for the lobby shot
  for (const k of ['japanesque', 'elvish', 'polynesian']) {
    await hp.check(`#src-${k}`).catch(() => {});
  }
  await wait(400);
  await shot(hp, '2-lobby');

  // guest joins
  const code = (await hp.textContent('#room-code')).trim();
  await gp.goto(URL);
  await gp.click('#btn-enter');
  await gp.fill('#name-input', 'Bjarne');
  await gp.fill('#code-input', code);
  await gp.click('#btn-join');
  await gp.waitForSelector('#screen-lobby.active');

  await hp.click('#btn-start');
  await hp.waitForSelector('#screen-play.active');
  await hp.fill('#guess-input', 'krindel');
  await hp.click('#btn-hear-self'); // stack a preview try with its waveform
  await wait(1000);
  await shot(hp, '3-play');

  await gp.waitForSelector('#screen-play.active');
  await gp.fill('#guess-input', 'grindle');
  await gp.click('#btn-hear-self');
  await wait(400);
  await gp.click('#guess-form button[type=submit]');
  await hp.click('#guess-form button[type=submit]');

  await hp.waitForSelector('#screen-reveal.active');
  await wait(1100); // let waveforms draw
  await shot(hp, '4-reveal');

  // skip the countdown straight to the final standings
  await hp.click('#btn-next-round');
  await hp.waitForSelector('#screen-over.active', { timeout: 10000 });
  await wait(900); // confetti + standings
  await shot(hp, '5-gameover', false);

  await browser.close();
  server.kill();
  console.log('Saved screenshots to', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
