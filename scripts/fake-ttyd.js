#!/usr/bin/env node
'use strict';

/**
 * A stand-in for `ttyd -p <port> -i 127.0.0.1 -b /term/<slug> -W tmux new -A -s <slug>`,
 * for developing and testing on a machine where ttyd is not installed.
 *
 *   node scripts/fake-ttyd.js <slug> <port> [command...]
 *
 * It serves the same surface the real ttyd does under its base path and speaks
 * the same WebSocket protocol, so the frontend cannot tell the difference:
 *
 *   GET  /term/<slug>/token   -> {"token":""}
 *   WS   /term/<slug>/ws      subprotocol "tty", binary frames
 *                             client: {AuthToken,columns,rows} then
 *                                     '0' input | '1' resize | '2' pause | '3' resume
 *                             server: '0' output | '1' title | '2' preferences
 *
 * The pty comes from scripts/ptyhost.py (python3 stdlib) rather than a native
 * addon, so `npm install` stays free of build tooling. Default command is
 * `tmux new -A -s <slug>`, matching systemd/ttyd@.service; override it by
 * passing one after the port, e.g. `... 7681 bash --norc -i`.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const [, , slug, portArg, ...cmdArgs] = process.argv;
if (!slug || !portArg) {
  console.error('usage: node scripts/fake-ttyd.js <slug> <port> [command...]');
  process.exit(2);
}
const port = Number(portArg);
const prefix = `/term/${slug}`;
const command = cmdArgs.length ? cmdArgs : ['tmux', 'new', '-A', '-s', slug];
const PTYHOST = path.join(__dirname, 'ptyhost.py');

const CMD = {
  OUTPUT: 0x30, // '0'
  SET_WINDOW_TITLE: 0x31, // '1'
  SET_PREFERENCES: 0x32, // '2'
  INPUT: 0x30,
  RESIZE_TERMINAL: 0x31,
  PAUSE: 0x32,
  RESUME: 0x33,
};

const frame = (cmdByte, payload) =>
  Buffer.concat([Buffer.from([cmdByte]), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);

const server = http.createServer((req, res) => {
  if (!req.url.startsWith(prefix)) {
    res.writeHead(404).end(`fake-ttyd: ${req.url} is outside base-path ${prefix}\n`);
    return;
  }
  if (req.url === `${prefix}/token`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":""}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' })
    .end(`<!doctype html><meta charset="utf-8"><title>fake-ttyd ${slug}</title>
<body style="font:14px/1.5 monospace;padding:2rem;background:#12151b;color:#d5dae2">
fake-ttyd for <b>${slug}</b> on 127.0.0.1:${port}. The real UI is at <a href="/">/</a>.
</body>`);
});

const wss = new WebSocketServer({ server, path: `${prefix}/ws`, handleProtocols: () => 'tty' });

wss.on('connection', (ws) => {
  let child = null;
  let ctrl = null;

  const start = (cols, rows) => {
    console.log(`  spawn ${command.join(' ')} (${cols}x${rows})`);
    child = spawn('python3', [PTYHOST, String(cols), String(rows), ...command], {
      // fd 3 is ptyhost's resize control channel.
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    });
    ctrl = child.stdio[3];
    child.stdout.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(frame(CMD.OUTPUT, chunk), { binary: true });
    });
    child.on('exit', (code) => {
      console.log(`  child exited (${code})`);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'process exited');
    });
    ws.send(frame(CMD.SET_WINDOW_TITLE, slug), { binary: true });
    ws.send(frame(CMD.SET_PREFERENCES, '{}'), { binary: true });
  };

  ws.on('message', (raw) => {
    const buf = Buffer.from(raw);
    if (buf.length === 0) return;

    // ttyd treats a leading '{' as the JSON init/auth message.
    if (!child) {
      if (buf[0] !== 0x7b) return;
      let init = {};
      try {
        init = JSON.parse(buf.toString('utf8'));
      } catch {
        ws.close(1002, 'bad init');
        return;
      }
      start(init.columns || 80, init.rows || 24);
      return;
    }

    const payload = buf.subarray(1);
    switch (buf[0]) {
      case CMD.INPUT:
        child.stdin.write(payload);
        break;
      case CMD.RESIZE_TERMINAL:
        try {
          const { columns, rows } = JSON.parse(payload.toString('utf8'));
          if (columns > 0 && rows > 0) ctrl.write(`${columns} ${rows}\n`);
        } catch {
          /* ignore a malformed resize */
        }
        break;
      case CMD.PAUSE:
        child.stdout.pause();
        break;
      case CMD.RESUME:
        child.stdout.resume();
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (child) child.kill('SIGHUP');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-ttyd "${slug}" on http://127.0.0.1:${port}${prefix}/  ->  ${command.join(' ')}`);
});
