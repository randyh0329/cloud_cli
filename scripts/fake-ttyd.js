#!/usr/bin/env node
'use strict';

/**
 * A stand-in for `ttyd -p <port> -b /term/<slug>`, for exercising the reverse
 * proxy on a machine where ttyd is not installed.
 *
 *   node scripts/fake-ttyd.js <slug> <port>
 *
 * Serves an HTML page at /term/<slug>/ and a `tty`-subprotocol WebSocket at
 * /term/<slug>/ws that echoes whatever you send it, so a round trip through
 * the proxy is visible in the browser.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const [, , slug, portArg] = process.argv;
if (!slug || !portArg) {
  console.error('usage: node scripts/fake-ttyd.js <slug> <port>');
  process.exit(2);
}
const port = Number(portArg);
const prefix = `/term/${slug}`;

const server = http.createServer((req, res) => {
  console.log(`  HTTP ${req.method} ${req.url}`);
  if (!req.url.startsWith(prefix)) {
    res.writeHead(404).end(`fake-ttyd: ${req.url} is outside base-path ${prefix}\n`);
    return;
  }
  if (req.url === `${prefix}/token`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":""}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<meta charset="utf-8"><title>fake-ttyd ${slug}</title>
<body style="font:14px/1.5 monospace;padding:2rem">
<h1>fake-ttyd — ${slug}</h1>
<p>Reached via <code>${req.url}</code> on 127.0.0.1:${port}.</p>
<p>WebSocket: <b id="s">connecting…</b></p>
<script>
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '${prefix}/ws', 'tty');
  ws.onopen = () => { document.getElementById('s').textContent = 'open (' + ws.protocol + ')'; ws.send('ping'); };
  ws.onmessage = e => { document.getElementById('s').textContent += ' | recv: ' + e.data; };
  ws.onerror = () => { document.getElementById('s').textContent = 'ERROR'; };
</script>
</body>`);
});

const wss = new WebSocketServer({ server, path: `${prefix}/ws`, handleProtocols: () => 'tty' });
wss.on('connection', (ws, req) => {
  console.log(`  WS   open ${req.url}`);
  ws.send(`fake-ttyd ${slug} ready`);
  ws.on('message', (data, isBinary) => {
    console.log(`  WS   echo ${data.length}B`);
    ws.send(data, { binary: isBinary });
  });
  ws.on('close', () => console.log('  WS   close'));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-ttyd "${slug}" on http://127.0.0.1:${port}${prefix}/`);
});
