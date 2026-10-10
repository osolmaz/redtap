// Serve smoke: start builder/serve.mjs against the local-backend fixture and
// exercise the HTTP surface the way a browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toV1Lines } from '../extension/lib/v1log.js';
import { makeBucketMirror, fixtureRecords, POST_DAY } from './helpers/v1-fixture.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mkdtemp = () => mkdtempSync(join(tmpdir(), 'redtap-test-'));

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

test('the server ingests a sealed v1 segment and shows it on the feed', async () => {
  const watchDir = join(await mkdtemp(), 'redtap-outbox');
  const now = new Date();
  mkdirSync(join(watchDir, 'v1', 'log', ...now.toISOString().slice(0, 10).split('-')), { recursive: true });
  const { child, mirror, url } = await startServe(['--watch-dir', watchDir]);
  try {
    const record = { ...fixtureRecords()[0], observation_id: 'obs-ingest', post_id: 't3_fixingest', title: 'Ingested fixture post', captured_at: Date.now(), metrics: { score: 7, comments: 1, upvote_ratio: 0.8 } };
    const lines = await toV1Lines([record], new Set(), digest);
    const stamp = String(now.getTime()).padStart(13, '0');
    const segPath = `v1/log/${now.toISOString().slice(0, 10).replace(/-/g, '/')}/${stamp}-${randomUUID()}.jsonl.gz`;
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(join(watchDir, segPath), gzipSync(Buffer.from(text, 'utf-8')));

    // the watcher ingests the segment into the local mirror, gzipped as-is
    let gunzip = null;
    for (let i = 0; i < 20 && !gunzip; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { gunzip = gunzipSync(readFileSync(join(mirror, segPath))); } catch {}
    }
    assert.ok(gunzip, 'segment was not ingested into the mirror');
    assert.ok(gunzip.toString().includes('t3_fixingest'));

    // the ingest triggers a data refresh: the front page shows the new post
    await new Promise((r) => setTimeout(r, 1500));
    const home = await get(url, '/');
    assert.ok(home.body.includes('Ingested fixture post'));
  } finally {
    child.kill('SIGTERM');
  }
});