'use strict';

/**
 * Drives the real frontend in a real browser against a real pty.
 *
 * Chrome comes from the system (CHROME_PATH or /usr/bin/google-chrome) and the
 * terminal backend is scripts/fake-ttyd.js, which speaks ttyd's wire protocol
 * over scripts/ptyhost.py. Everything else — the proxy, the registry, the API —
 * is the production code path.
 *
 * Skipped, not failed, when Chrome is missing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after, describe } = require('node:test');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const haveChrome = fs.existsSync(CHROME);

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-fe-'));
process.env.WEBTERM_STUB_SUPERVISOR = '1';
// Keep any tmux the fake backend might start away from the user's own server.
process.env.TMUX_TMPDIR = process.env.WEBTERM_HOME;

const registry = require('../server/registry');
const proxy = require('../server/proxy');
const { createApp } = require('../server/app');

const ROOT = path.join(__dirname, '..');
const children = [];
let server;
let base;
let browser;
let page;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function addProject(slug, port) {
  await registry.transaction((d) => {
    d[slug] = {
      port,
      cwd: os.tmpdir(),
      created_at: new Date(Date.now() + Object.keys(d).length).toISOString(),
      screenshot_dir: os.tmpdir(),
    };
  });
}

/** Start a fake-ttyd running a bare bash on a pty, and wait for it to listen. */
async function startBackend(slug, port) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts/fake-ttyd.js'), slug, String(port), 'bash', '--norc', '--noprofile', '-i'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PS1: `${slug}$ ` } }
  );
  children.push(child);
  child.stderr.on('data', (d) => process.env.WEBTERM_DEBUG && process.stderr.write(`[${slug}] ${d}`));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`fake-ttyd ${slug} did not start`)), 10000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('fake-ttyd')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return child;
}

/** Whole scrollback of a project's terminal, as text. */
const bufferText = (slug) =>
  page.evaluate((s) => {
    const t = window.webterm.tabs.get(s);
    if (!t || !t.term || !t.term.term) return null;
    const buf = t.term.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }, slug);

/**
 * Fire a real `paste` event at the focused terminal with a synthetic clipboard.
 * Existing toasts are cleared first so an assertion cannot match a stale one.
 */
async function paste(pg, { image = false, text = '' }) {
  await pg.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await pg.evaluate(
    (opts) => {
      const dt = new DataTransfer();
      if (opts.image) {
        const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        const body = [...'IHDR and a fake png body'].map((c) => c.charCodeAt(0));
        dt.items.add(
          new File([new Uint8Array([...head, ...body])], 'screenshot.png', { type: 'image/png' })
        );
      }
      if (opts.text) dt.setData('text/plain', opts.text);
      const target = document.querySelector('.pane.active .xterm-helper-textarea') || document.body;
      target.focus();
      target.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    },
    { image, text }
  );
}

const tabState = (slug) =>
  page.evaluate((s) => {
    const t = window.webterm.tabs.get(s);
    if (!t) return null;
    return {
      dot: t.dot.dataset.state,
      paneActive: t.pane.classList.contains('active'),
      paneDisplay: getComputedStyle(t.pane).display,
      hasTerm: Boolean(t.term),
      socketOpen: Boolean(t.term && t.term.socket && t.term.socket.readyState === 1),
      selected: t.tab.getAttribute('aria-selected'),
    };
  }, slug);

describe('frontend', { skip: haveChrome ? false : `Chrome not found at ${CHROME}` }, () => {
  before(async () => {
    await registry.init();
    server = http.createServer(createApp());
    server.on('upgrade', proxy.handleUpgrade);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    for (const slug of ['alpha', 'beta']) {
      const port = await freePort();
      await addProject(slug, port);
      await startBackend(slug, port);
    }

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (err) => assert.fail(`uncaught page error: ${err.message}`));
    page.on('console', (m) => {
      if (process.env.WEBTERM_DEBUG) console.log(`[page:${m.type()}] ${m.text()}`);
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab');
  });

  after(async () => {
    if (browser) await browser.close();
    for (const c of children) c.kill('SIGKILL');
    proxy.close();
    if (server) server.close();
    fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
  });

  test('tabs are rebuilt from GET /api/projects on load', async () => {
    const names = await page.$$eval('.tab .name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(names, ['alpha', 'beta']);
    assert.equal((await tabState('alpha')).selected, 'true', 'first tab is active on load');
    assert.equal((await tabState('beta')).selected, 'false');
  });

  test('only the active tab has a terminal (lazy open)', async () => {
    assert.equal((await tabState('alpha')).hasTerm, true);
    assert.equal((await tabState('beta')).hasTerm, false);
  });

  test('the active terminal connects and shows a live shell', async () => {
    await page.waitForFunction(
      () => window.webterm.tabs.get('alpha').dot.dataset.state === 'open',
      { timeout: 15000 }
    );
    await page.keyboard.type('echo READY-$((6*7))\n');
    await page.waitForFunction(
      () => {
        const b = window.webterm.tabs.get('alpha').term.term.buffer.active;
        for (let i = 0; i < b.length; i += 1) {
          if ((b.getLine(i)?.translateToString(true) || '').includes('READY-42')) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    assert.match(await bufferText('alpha'), /READY-42/);
  });

  test('the terminal is sized to the pane, and the pty agrees', async () => {
    const cols = await page.evaluate(() => window.webterm.tabs.get('alpha').term.term.cols);
    assert.ok(cols > 80, `expected a wide terminal from FitAddon, got ${cols} cols`);

    await page.keyboard.type('stty size\n');
    await page.waitForFunction(
      (want) => {
        const b = window.webterm.tabs.get('alpha').term.term.buffer.active;
        for (let i = 0; i < b.length; i += 1) {
          if ((b.getLine(i)?.translateToString(true) || '').trim().endsWith(` ${want}`)) return true;
        }
        return false;
      },
      { timeout: 15000 },
      cols
    );
  });

  test('switching tabs hides the pane but keeps the socket open', async () => {
    await page.click('.tab[data-slug="beta"]');
    await page.waitForFunction(
      () => window.webterm.tabs.get('beta').dot.dataset.state === 'open',
      { timeout: 15000 }
    );

    const alpha = await tabState('alpha');
    assert.equal(alpha.paneActive, false);
    assert.equal(alpha.paneDisplay, 'none', 'inactive pane is hidden');
    assert.equal(alpha.hasTerm, true, 'inactive terminal is NOT destroyed');
    assert.equal(alpha.socketOpen, true, 'inactive WebSocket stays connected');

    const beta = await tabState('beta');
    assert.equal(beta.paneActive, true);
    assert.equal(beta.hasTerm, true);
  });

  test('each tab has its own independent shell', async () => {
    await page.keyboard.type('echo ONLY-IN-BETA\n');
    await page.waitForFunction(
      () => {
        const b = window.webterm.tabs.get('beta').term.term.buffer.active;
        for (let i = 0; i < b.length; i += 1) {
          if ((b.getLine(i)?.translateToString(true) || '').includes('ONLY-IN-BETA')) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    assert.doesNotMatch(await bufferText('alpha'), /ONLY-IN-BETA/);
  });

  test('switching back preserves the earlier scrollback', async () => {
    await page.click('.tab[data-slug="alpha"]');
    await page.waitForFunction(() => window.webterm.tabs.get('alpha').pane.classList.contains('active'));
    assert.match(await bufferText('alpha'), /READY-42/, 'scrollback survived the tab switch');
  });

  test('pasting an image uploads it and types the path into the active project', async () => {
    const supervisor = require('../server/supervisor');
    const before = supervisor._injected.length;

    await paste(page, { image: true });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('pasted → ')),
      { timeout: 15000 }
    );

    assert.equal(supervisor._injected.length, before + 1, 'exactly one injection');
    const { slug, text } = supervisor._injected.at(-1);
    assert.equal(slug, 'alpha', 'the upload used the active tab');
    assert.match(text, / $/);
    assert.doesNotMatch(text, /[\r\n]/, 'no Enter was sent');

    const saved = text.trim();
    assert.equal(fs.existsSync(saved), true, `expected a file at ${saved}`);
    assert.equal(fs.readFileSync(saved).subarray(0, 4).toString('latin1'), '\x89PNG');

    const toast = await page.$eval('.toast', (el) => el.textContent);
    assert.equal(toast, `pasted → ${saved}`);
  });

  test('pasting text is left to the terminal, with no upload', async () => {
    const supervisor = require('../server/supervisor');
    const before = supervisor._injected.length;

    await paste(page, { text: 'PASTED-PLAIN-TEXT' });
    await page.waitForFunction(
      () => {
        const b = window.webterm.tabs.get('alpha').term.term.buffer.active;
        for (let i = 0; i < b.length; i += 1) {
          if ((b.getLine(i)?.translateToString(true) || '').includes('PASTED-PLAIN-TEXT')) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );
    assert.equal(supervisor._injected.length, before, 'a text paste must not hit /api/upload');
    // Clear the line so it does not interfere with later tests.
    await page.keyboard.press('Escape');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyU');
    await page.keyboard.up('Control');
  });

  test('the paste targets whichever tab is active', async () => {
    const supervisor = require('../server/supervisor');
    await page.click('.tab[data-slug="beta"]');
    await page.waitForFunction(() => window.webterm.activeSlug() === 'beta');

    await paste(page, { image: true });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('pasted → ')),
      { timeout: 15000 }
    );
    assert.equal(supervisor._injected.at(-1).slug, 'beta');

    await page.click('.tab[data-slug="alpha"]');
    await page.waitForFunction(() => window.webterm.activeSlug() === 'alpha');
  });

  test('+ New Project creates a project and opens its tab', async () => {
    await page.click('#new-project');
    await page.waitForFunction(() => document.querySelector('#new-dialog').open);
    await page.type('#f-slug', 'gamma');
    await page.click('#f-create');

    await page.waitForFunction(() => window.webterm.tabs.has('gamma'), { timeout: 15000 });
    const created = await (await fetch(`${base}/api/projects/gamma`)).json();
    assert.equal(created.slug, 'gamma');
    assert.equal((await tabState('gamma')).selected, 'true', 'the new tab is focused');
  });

  test('a project with no ttyd behind it shows the reconnect overlay, not a hang', async () => {
    // 'gamma' was created with the stub supervisor, so nothing is listening.
    await page.waitForFunction(
      () => ['down', 'closed', 'error'].includes(window.webterm.tabs.get('gamma').dot.dataset.state),
      { timeout: 20000 }
    );
    const text = await page.$eval('.pane[data-slug="gamma"] .pane-overlay', (el) => el.innerText);
    assert.match(text, /ttyd@gamma\.service|Disconnected/);
  });

  test('an invalid slug is rejected in the dialog without a request', async () => {
    await page.click('#new-project');
    await page.waitForFunction(() => document.querySelector('#new-dialog').open);
    await page.type('#f-slug', 'Bad Slug!');
    await page.click('#f-create');
    await page.waitForFunction(() => !document.querySelector('#f-error').hidden);
    assert.match(await page.$eval('#f-error', (el) => el.textContent), /lowercase letters/);
    await page.evaluate(() => document.querySelector('#new-dialog').close('cancel'));
  });

  test('right-clicking a tab deletes the project after confirmation', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('.tab[data-slug="gamma"]', { button: 'right' });

    await page.waitForFunction(() => !window.webterm.tabs.has('gamma'), { timeout: 15000 });
    assert.equal((await fetch(`${base}/api/projects/gamma`)).status, 404);
    assert.equal(await page.$('.pane[data-slug="gamma"]'), null, 'the pane is removed too');
  });

  test('declining the confirmation keeps the project', async () => {
    page.once('dialog', (d) => d.dismiss());
    await page.click('.tab[data-slug="beta"]', { button: 'right' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await fetch(`${base}/api/projects/beta`)).status, 200);
    assert.ok(await page.$('.tab[data-slug="beta"]'));
  });

  test('a reload rebuilds the same tabs from the server', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab');
    const names = await page.$$eval('.tab .name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(names, ['alpha', 'beta']);
  });
});
