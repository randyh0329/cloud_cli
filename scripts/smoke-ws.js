#!/usr/bin/env node
'use strict';

/**
 * Speak ttyd's WebSocket protocol to a real ttyd, through webterm's proxy.
 *
 *   node scripts/smoke-ws.js --base http://127.0.0.1:3999 --slug smoke-abc
 *
 * This is the one check that cannot be faked: it proves the /term/<slug>/token
 * endpoint, the Upgrade leg of the proxy, ttyd's `-b` base path, the `tty`
 * subprotocol, the auth frame, bidirectional data and client-driven resize all
 * line up end to end. scripts/fake-ttyd.js implements the same protocol, so a
 * disagreement here is real ttyd telling us our client is wrong.
 *
 * Exits 0 on success; on failure prints what it was waiting for and exits 1.
 */

const WebSocket = require('ws');

const CMD = {
  OUTPUT: '0',
  SET_WINDOW_TITLE: '1',
  SET_PREFERENCES: '2',
  INPUT: '0',
  RESIZE_TERMINAL: '1',
};

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const BASE = args.get('base') || 'http://127.0.0.1:3999';
const SLUG = args.get('slug');
const TIMEOUT = Number(args.get('timeout') || 25000);
if (!SLUG) {
  console.error('usage: smoke-ws.js --base <http://host:port> --slug <slug> [--timeout ms]');
  process.exit(2);
}

const PREFIX = `${BASE.replace(/\/$/, '')}/term/${SLUG}`;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg) => console.log(`    ${msg}`);

let buffer = '';           // everything the pty has printed
let sawTitle = false;
let sawPreferences = false;
let socket = null;

const strip = (s) =>
  // Enough ANSI removal to make text matching reliable; tmux draws a lot of it.
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

function send(cmd, payload = '') {
  socket.send(Buffer.concat([Buffer.from(cmd, 'latin1'), Buffer.from(payload, 'utf8')]));
}

/** Resolve once `test(buffer)` is true, or reject after `ms` with what we saw. */
function waitFor(what, test, ms = 12000) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (test(buffer)) {
        clearInterval(timer);
        clearTimeout(bomb);
        resolve();
      }
    };
    const timer = setInterval(tick, 100);
    const bomb = setTimeout(() => {
      clearInterval(timer);
      const tail = buffer.slice(-800);
      reject(new Error(`timed out waiting for ${what}\n--- last output ---\n${tail}\n---`));
    }, ms);
    tick();
  });
}

async function main() {
  // 1. The token endpoint — served by ttyd itself under -b /term/<slug>.
  const tokenRes = await fetch(`${PREFIX}/token`);
  if (!tokenRes.ok) throw new Error(`GET ${PREFIX}/token -> ${tokenRes.status}`);
  const ctype = tokenRes.headers.get('content-type') || '';
  if (!/json/i.test(ctype)) throw new Error(`/token returned ${ctype}, expected JSON`);
  const { token } = await tokenRes.json();
  if (typeof token !== 'string') throw new Error(`/token has no string "token" field`);
  ok(`GET /term/${SLUG}/token -> 200 (token ${token ? `${token.length} chars` : 'empty'})`);

  // 2. Upgrade through the proxy. Bad subprotocol handling shows up right here.
  const wsUrl = `${PREFIX.replace(/^http/, 'ws')}/ws`;
  socket = new WebSocket(wsUrl, ['tty'], { perMessageDeflate: false });
  socket.binaryType = 'nodebuffer';

  await new Promise((resolve, reject) => {
    const bomb = setTimeout(() => reject(new Error(`no WebSocket open on ${wsUrl} within 10s`)), 10000);
    socket.once('open', () => { clearTimeout(bomb); resolve(); });
    socket.once('error', (err) => { clearTimeout(bomb); reject(new Error(`${wsUrl}: ${err.message}`)); });
    socket.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused: HTTP ${res.statusCode} ${res.statusMessage}`))
    );
  });
  if (socket.protocol !== 'tty') throw new Error(`negotiated subprotocol "${socket.protocol}", expected "tty"`);
  ok(`WebSocket ${wsUrl} open, subprotocol "tty"`);

  socket.on('close', (code, reason) => {
    if (!done) {
      console.error(`\n  socket closed early: ${code} ${reason || ''}`);
      process.exit(1);
    }
  });
  socket.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0) return;
    const cmd = String.fromCharCode(buf[0]);
    const payload = buf.subarray(1);
    if (cmd === CMD.OUTPUT) buffer += strip(payload.toString('utf8'));
    else if (cmd === CMD.SET_WINDOW_TITLE) sawTitle = true;
    else if (cmd === CMD.SET_PREFERENCES) sawPreferences = true;
  });

  // 3. The auth frame is plain JSON with no command byte — ttyd dispatches on
  //    the leading '{'. Getting this wrong just hangs, so it is worth asserting.
  const COLS = 120;
  const ROWS = 40;
  socket.send(JSON.stringify({ AuthToken: token, columns: COLS, rows: ROWS }));
  await waitFor('the first byte of pty output after the auth frame', (b) => b.length > 0, 10000);
  ok(`auth frame accepted; pty is producing output`);

  // 4. Round-trip a command. The doubled quotes mean the echoed *input* line
  //    does not itself contain the marker, so a match is real program output.
  const nonce = `${process.pid.toString(36)}${process.hrtime.bigint().toString(36).slice(-6)}`;
  const marker = `SMOKE-${nonce}`;
  send(CMD.INPUT, `echo "SM""OKE-${nonce}"\n`);
  await waitFor(`"${marker}" in the pty output`, (b) => b.includes(marker));
  ok(`input reached the shell and its output came back ("${marker}")`);

  // 5. Client-driven resize. ttyd needs -W for this; without it the request is
  //    silently ignored and this step is what catches it.
  //    tmux's status line means the *pane* is one row shorter than the window.
  const NEW_COLS = 96;
  const NEW_ROWS = 32;
  send(CMD.RESIZE_TERMINAL, JSON.stringify({ columns: NEW_COLS, rows: NEW_ROWS }));
  await new Promise((r) => setTimeout(r, 400));
  buffer = '';
  send(CMD.INPUT, 'stty size\n');
  const sizeRe = new RegExp(`\\b(\\d+) ${NEW_COLS}\\b`);
  await waitFor(`stty to report ${NEW_COLS} columns`, (b) => sizeRe.test(b));
  const rows = Number(sizeRe.exec(buffer)[1]);
  if (Math.abs(rows - NEW_ROWS) > 2) {
    throw new Error(`pty reported ${rows} rows, expected about ${NEW_ROWS}`);
  }
  ok(`resize honoured: pty is now ${rows}x${NEW_COLS} (asked for ${NEW_ROWS}x${NEW_COLS})`);

  if (sawTitle) ok('server sent SET_WINDOW_TITLE');
  else info('note: no SET_WINDOW_TITLE frame (cosmetic only)');
  if (sawPreferences) ok('server sent SET_PREFERENCES');

  // Leave the session as we found it — no stray half-typed line.
  send(CMD.INPUT, '\x15');
  await new Promise((r) => setTimeout(r, 150));
}

let done = false;
const bail = setTimeout(() => {
  console.error(`\n  smoke-ws timed out after ${TIMEOUT}ms`);
  process.exit(1);
}, TIMEOUT);
bail.unref();

main()
  .then(() => {
    done = true;
    if (socket) socket.close();
    process.exit(0);
  })
  .catch((err) => {
    done = true;
    console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`);
    if (socket) socket.close();
    process.exit(1);
  });
