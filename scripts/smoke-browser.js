#!/usr/bin/env node
'use strict';

/**
 * Drive the real UI in a headless browser against real ttyd + real tmux.
 *
 *   node scripts/smoke-browser.js --base http://127.0.0.1:3999 --slug smoke-abc
 *
 * test/frontend.test.js already does this against scripts/fake-ttyd.js. The
 * point of running it again here is that nothing is stubbed: the terminal on
 * screen is ttyd's pty attached to a tmux session managed by systemd, and the
 * paste assertion closes the whole loop —
 *
 *   ClipboardEvent -> POST /api/upload -> tmux send-keys -> ttyd -> WebSocket
 *   -> the path appearing as typed text in the browser's own terminal buffer.
 *
 * Writes a PNG of the finished page to --shot (default /tmp/webterm-smoke.png)
 * so a failure on a headless VM is still something you can look at.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const BASE = args.get('base') || 'http://127.0.0.1:3999';
const SLUG = args.get('slug');
const SHOT = args.get('shot') || '/tmp/webterm-smoke.png';
if (!SLUG) {
  console.error('usage: smoke-browser.js --base <url> --slug <slug> [--shot out.png]');
  process.exit(2);
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const skip = (msg) => console.log(`  \x1b[33m-\x1b[0m ${msg}`);

if (!CHROME) {
  skip(`no browser found (looked in ${CANDIDATES.join(', ')}) — skipping the UI smoke test`);
  process.exit(0);
}

/** The whole scrollback of a tab's terminal, as plain text. */
const readBuffer = (page, slug) =>
  page.evaluate((s) => {
    const t = window.webterm.tabs.get(s);
    if (!t || !t.term || !t.term.term) return '';
    const b = t.term.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i += 1) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n');
  }, slug);

const waitForText = (page, slug, needle, timeout = 20000) =>
  page.waitForFunction(
    (s, want) => {
      const t = window.webterm.tabs.get(s);
      if (!t || !t.term || !t.term.term) return false;
      const b = t.term.term.buffer.active;
      for (let i = 0; i < b.length; i += 1) {
        if ((b.getLine(i)?.translateToString(true) || '').includes(want)) return true;
      }
      return false;
    },
    { timeout },
    slug,
    needle
  );

async function main() {
  const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`.tab[data-slug="${SLUG}"]`, { timeout: 15000 });
    ok(`the page loaded and rebuilt the "${SLUG}" tab from GET /api/projects`);

    await page.click(`.tab[data-slug="${SLUG}"]`);
    await page.waitForFunction(
      (s) => window.webterm.tabs.get(s)?.dot?.dataset.state === 'open',
      { timeout: 20000 },
      SLUG
    );
    ok('the tab connected to real ttyd (status dot: open)');

    // A real shell behind a real pty behind a real WebSocket.
    const nonce = process.hrtime.bigint().toString(36).slice(-7);
    await page.keyboard.type(`echo "BROWSER""-OK-${nonce}"\n`);
    await waitForText(page, SLUG, `BROWSER-OK-${nonce}`);
    ok(`typed a command and read its output back ("BROWSER-OK-${nonce}")`);

    // FitAddon sized the terminal; tmux should have been told about it.
    const cols = await page.evaluate((s) => window.webterm.tabs.get(s).term.term.cols, SLUG);
    await page.keyboard.type('stty size\n');
    await waitForText(page, SLUG, ` ${cols}`, 20000);
    const buf = await readBuffer(page, SLUG);
    const sizeLine = buf
      .split('\n')
      .map((l) => /^\s*(\d+) (\d+)\s*$/.exec(l))
      .filter(Boolean)
      .pop();
    if (!sizeLine) throw new Error(`stty size printed nothing parseable; buffer tail:\n${buf.slice(-400)}`);
    const [, ptyRows, ptyCols] = sizeLine;
    if (Number(ptyCols) !== cols) {
      throw new Error(`xterm chose ${cols} columns but the pty reports ${ptyCols}`);
    }
    ok(`the pty agrees with the browser's geometry (${ptyRows}x${ptyCols})`);

    // Paste a PNG. Same synthetic ClipboardEvent the frontend test uses; the
    // difference is that the path now has to come back through real ttyd.
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const body = [...'IHDR smoke-test png body'].map((c) => c.charCodeAt(0));
      dt.items.add(new File([new Uint8Array([...head, ...body])], 'clip.png', { type: 'image/png' }));
      const target = document.querySelector('.pane.active .xterm-helper-textarea') || document.body;
      target.focus();
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('pasted → ')),
      { timeout: 20000 }
    );
    const toast = await page.$eval('.toast', (el) => el.textContent);
    const saved = toast.replace('pasted → ', '').trim();
    ok(`paste uploaded: ${saved}`);

    if (!fs.existsSync(saved)) throw new Error(`the toast names ${saved} but no such file exists`);
    const magic = fs.readFileSync(saved).subarray(0, 4).toString('latin1');
    if (magic !== '\x89PNG') throw new Error(`${saved} does not start with the PNG signature`);
    const mode = fs.statSync(saved).mode & 0o777;
    if (mode !== 0o600) throw new Error(`${saved} is mode ${mode.toString(8)}, expected 600`);
    ok('the file is on disk, is a PNG, and is mode 0600');

    // The payoff: tmux typed it, ttyd streamed it, xterm rendered it.
    await waitForText(page, SLUG, path.basename(saved), 20000);
    ok('tmux typed the path into the session and it arrived in the browser terminal');

    // Clear the half-typed line so the session is left clean.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyU');
    await page.keyboard.up('Control');

    await page.screenshot({ path: SHOT });
    ok(`screenshot written to ${SHOT}`);

    if (pageErrors.length) throw new Error(`uncaught page errors:\n    ${pageErrors.join('\n    ')}`);
    ok('no uncaught JavaScript errors on the page');
  } finally {
    await browser.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`);
    process.exit(1);
  });
