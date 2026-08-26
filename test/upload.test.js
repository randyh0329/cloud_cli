'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-upload-'));
process.env.WEBTERM_STUB_SUPERVISOR = '1';
process.env.WEBTERM_MAX_UPLOAD_BYTES = String(64 * 1024);

const config = require('../server/config');
const registry = require('../server/registry');
const supervisor = require('../server/supervisor');
const screenshots = require('../server/screenshots');
const { createApp } = require('../server/app');

let server;
let base;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest-of-a-png'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF...')]);
const GIF = Buffer.from('GIF89a and some pixels');
const NOT_AN_IMAGE = Buffer.from('%PDF-1.7\nnot an image at all\n');

/** POST a multipart body to /api/upload. */
async function post({ project, bytes, filename = 'clipboard.png', type = 'image/png', omitFile }) {
  const form = new FormData();
  if (project !== undefined) form.append('project', project);
  if (!omitFile) form.append('file', new Blob([bytes], { type }), filename);
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const injected = () => supervisor._injected;
const lastInjected = () => supervisor._injected.at(-1);

before(async () => {
  await registry.init();
  await registry.transaction((d) => {
    d['alpha'] = {
      port: 7681,
      cwd: os.tmpdir(),
      created_at: new Date().toISOString(),
      screenshot_dir: path.join(config.SCREENSHOTS_DIR, 'alpha'),
    };
    // A hand-edited registry entry pointing outside the screenshots root.
    d['tampered'] = {
      port: 7682,
      cwd: os.tmpdir(),
      created_at: new Date().toISOString(),
      screenshot_dir: '/tmp/webterm-escape',
    };
  });
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
  fs.rmSync('/tmp/webterm-escape', { recursive: true, force: true });
});

test('a pasted PNG is saved and its path typed into the session', async () => {
  const before = injected().length;
  const { status, body } = await post({ project: 'alpha', bytes: PNG });

  assert.equal(status, 200);
  assert.equal(body.project, 'alpha');
  assert.equal(body.injected, true);
  assert.equal(body.bytes, PNG.length);
  assert.equal(path.dirname(body.path), path.join(config.SCREENSHOTS_DIR, 'alpha'));
  assert.deepEqual(await fsp.readFile(body.path), PNG, 'the bytes on disk are the bytes sent');

  assert.equal(injected().length, before + 1);
  assert.equal(lastInjected().slug, 'alpha');
});

test('the injected keystrokes are the path plus one space — never a newline', async () => {
  await post({ project: 'alpha', bytes: PNG });
  const { text } = lastInjected();

  assert.match(text, / $/, 'a trailing space so the prompt can continue');
  assert.doesNotMatch(text, /[\r\n]/, 'no Enter: the line must not be submitted');
  assert.equal(text.trimEnd(), text.slice(0, -1));
  assert.ok(path.isAbsolute(text.trim()), 'an absolute path is typed');
});

test('the filename is a sortable timestamp, and never the client-supplied name', async () => {
  const { body } = await post({
    project: 'alpha',
    bytes: PNG,
    filename: '../../../../etc/cron.d/pwned.png',
  });
  assert.match(body.filename, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/);
  assert.equal(path.dirname(body.path), path.join(config.SCREENSHOTS_DIR, 'alpha'));
  assert.equal(fs.existsSync('/etc/cron.d/pwned.png'), false);
});

test('screenshots are written 0600', async () => {
  const { body } = await post({ project: 'alpha', bytes: PNG });
  const st = await fsp.stat(body.path);
  assert.equal(st.mode & 0o777, 0o600);
});

test('the extension comes from the bytes, not the declared type', async () => {
  const jpeg = await post({ project: 'alpha', bytes: JPEG, filename: 'x.png', type: 'image/png' });
  assert.match(jpeg.body.filename, /\.jpg$/);

  const gif = await post({ project: 'alpha', bytes: GIF, filename: 'x.txt', type: 'text/plain' });
  assert.match(gif.body.filename, /\.gif$/);
});

test('a non-image is rejected and nothing is written', async () => {
  const dir = path.join(config.SCREENSHOTS_DIR, 'alpha');
  const before = (await fsp.readdir(dir)).length;
  const injectedBefore = injected().length;

  const { status, body } = await post({
    project: 'alpha',
    bytes: NOT_AN_IMAGE,
    type: 'image/png', // lying about the type must not help
  });

  assert.equal(status, 400);
  assert.match(body.error, /not a recognised image/);
  assert.equal((await fsp.readdir(dir)).length, before, 'no file left behind');
  assert.equal(injected().length, injectedBefore, 'nothing typed into the session');
});

test('an oversized image is rejected with 413', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(config.MAX_UPLOAD_BYTES, 0x41)]);
  const { status, body } = await post({ project: 'alpha', bytes: big });
  assert.equal(status, 413);
  assert.match(body.error, /larger than/);
});

test('a missing or empty file part is a 400', async () => {
  assert.equal((await post({ project: 'alpha', omitFile: true })).status, 400);
  assert.equal((await post({ project: 'alpha', bytes: Buffer.alloc(0) })).status, 400);
});

test('unknown and malformed project slugs are refused', async () => {
  assert.equal((await post({ project: 'nope', bytes: PNG })).status, 404);
  assert.equal((await post({ project: '../alpha', bytes: PNG })).status, 400);
  assert.equal((await post({ project: 'Alpha', bytes: PNG })).status, 400);
  assert.equal((await post({ bytes: PNG })).status, 400);
});

test('pastes in the same millisecond get distinct filenames', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => post({ project: 'alpha', bytes: PNG }))
  );
  const paths = results.map((r) => r.body.path);
  assert.equal(new Set(paths).size, 8, 'no screenshot overwrote another');
  for (const p of paths) assert.equal(fs.existsSync(p), true);
});

test('a registry screenshot_dir outside the screenshots root is ignored', async () => {
  const { status, body } = await post({ project: 'tampered', bytes: PNG });
  assert.equal(status, 200);
  assert.equal(path.dirname(body.path), path.join(config.SCREENSHOTS_DIR, 'tampered'));
  assert.equal(fs.existsSync('/tmp/webterm-escape'), false);
});

test('only paths that need shell quoting get quoted', () => {
  const q = screenshots._shellQuote;
  // The normal case: a bare path, so Claude Code's path detection sees it plainly.
  const plain = '/home/you/webterm/screenshots/my-app/2026-01-01T00-00-00-000Z.png';
  assert.equal(q(plain), plain);
  // Only reachable if $HOME itself is awkward, but then an unquoted path would
  // be read by the shell as two arguments.
  assert.equal(q('/home/my name/shot.png'), "'/home/my name/shot.png'");
  assert.equal(q("/home/o'brien/shot.png"), "'/home/o'\\''brien/shot.png'");
  assert.equal(q('/home/$(id)/shot.png'), "'/home/$(id)/shot.png'");
});

test('sniffing recognises the formats we accept and nothing else', () => {
  const s = screenshots._sniff;
  assert.equal(s(PNG), 'png');
  assert.equal(s(JPEG), 'jpg');
  assert.equal(s(GIF), 'gif');
  assert.equal(s(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(s(NOT_AN_IMAGE), null);
  assert.equal(s(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(s(Buffer.alloc(0)), null);
});
