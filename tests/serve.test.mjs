// Serve smoke: start builder/serve.mjs against the local-backend fixture and
// exercise the HTTP surface the way a browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBucketMirror, POST_DAY } from './helpers/v2-fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function startServe(extraArgs = []) {
  const mirror = await makeBucketMirror();
  const child = spawn(process.execPath, [
    join(root, 'builder', 'serve.mjs'),
    '--backend', 'local', '--dir', mirror,
    '--host', '127.0.0.1', '--port', '0',
    ...extraArgs,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const listening = await new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('server did not report listening in 15s')), 15000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const line = out.split('\n').find((l) => l.startsWith('redtap-serve listening on '));
      if (line) { clearTimeout(fail); resolve(line.replace('redtap-serve listening on ', '').trim()); }
    });
    child.once('exit', (code) => { clearTimeout(fail); reject(new Error('serve exited early with code ' + code)); });
  });
  return { child, mirror, url: listening };
}

async function get(base, path) {
  const res = await fetch(new URL(path, base));
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

test('the server renders the site over http from a local folder', async () => {
  const { child, url } = await startServe();
  try {
    const home = await get(url, '/');
    assert.equal(home.status, 200);
    assert.equal(home.type, 'text/html');
    assert.ok(home.body.includes('Fixture post'));

    const browse = await get(url, '/hot/day/');
    assert.equal(browse.status, 200);
    assert.ok(browse.body.includes('Fixture post'));

    const sub = await get(url, '/r/LocalLLaMA/top/month/');
    assert.equal(sub.status, 200);
    assert.ok(sub.body.includes('Fixture post'));

    const day = await get(url, '/day/' + POST_DAY + '/');
    assert.equal(day.status, 200);
    assert.ok(day.body.includes('Fixture post'));

    const days = await get(url, '/days/');
    assert.equal(days.status, 200);
    assert.ok(days.body.includes(POST_DAY));

    const post = await get(url, '/r/LocalLLaMA/comments/fix000/');
    assert.equal(post.status, 200);
    assert.ok(post.body.includes('Fixture post'));

    const rss = await get(url, '/rss.xml');
    assert.equal(rss.status, 200);
    assert.equal(rss.type, 'application/rss+xml');
    assert.ok(rss.body.includes('<?xml'));
    assert.ok(rss.body.includes('http://127.0.0.1:' + new URL(url).port + '/'));

    const status = await get(url, '/status.json');
    assert.equal(status.status, 200);
    const parsed = JSON.parse(status.body);
    assert.equal(parsed.posts, 2);
    assert.ok(parsed.newestSightingMs > 0);

    const index = await get(url, '/index.json');
    assert.equal(JSON.parse(index.body).posts.length, 2);

    const missing = await get(url, '/definitely/not/here/');
    assert.equal(missing.status, 404);

    const noTrailingSlash = await get(url, '/hot');
    assert.equal(noTrailingSlash.status, 200);
    assert.ok(noTrailingSlash.body.includes('Fixture post'));
  } finally {
    child.kill('SIGTERM');
  }
});

test('the server applies a base prefix when asked', async () => {
  const { child, url } = await startServe(['--base', '/redtap']);
  try {
    const home = await get(url, '/redtap/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('href="/redtap/'));
    assert.ok(!home.body.includes('href="/hot/'));
  } finally {
    child.kill('SIGTERM');
  }
});