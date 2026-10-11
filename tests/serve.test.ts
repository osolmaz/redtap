import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { toV1Lines, type Digest } from '../extension/src/lib/v1log.ts';
import { fixtureRecords, makeBucketMirror, POST_DAY } from './helpers/v1-fixture.ts';

const digest: Digest = (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
const mkdtemp = (): string => mkdtempSync(join(tmpdir(), 'redtap-test-'));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const children: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const child of children) child.kill('SIGTERM');
});

async function startServe(extraArgs: string[] = []) {
  const mirror = await makeBucketMirror();
  const child = spawn(
    process.execPath,
    [
      join(root, 'builder', 'src', 'serve.ts'),
      '--backend',
      'local',
      '--dir',
      mirror,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      ...extraArgs,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  const listening = await new Promise<string>((resolve, reject) => {
    const fail = setTimeout(() => {
      reject(new Error('server did not report listening in 15s'));
    }, 15000);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((l) => l.startsWith('redtap-serve listening on '));
      if (line) {
        clearTimeout(fail);
        resolve(line.replace('redtap-serve listening on ', '').trim());
      }
    });
    child.once('exit', (code) => {
      clearTimeout(fail);
      reject(new Error(`serve exited early with code ${String(code)}`));
    });
  });
  return { child, mirror, url: listening };
}

async function get(base: string, path: string) {
  const res = await fetch(new URL(path, base));
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    body: Buffer.from(await res.arrayBuffer()),
  };
}

describe('serve', () => {
  it('the server renders the site over http from a local folder', async () => {
    const { child, url } = await startServe();
    try {
      const home = await get(url, '/');
      expect(home.status).toBe(200);
      expect(home.type).toBe('text/html');
      expect(home.body.includes('Fixture post')).toBe(true);

      const browse = await get(url, '/hot/day/');
      expect(browse.status).toBe(200);
      expect(browse.body.includes('Fixture post')).toBe(true);

      const sub = await get(url, '/r/LocalLLaMA/top/month/');
      expect(sub.status).toBe(200);
      expect(sub.body.includes('Fixture post')).toBe(true);

      const day = await get(url, '/day/' + POST_DAY + '/');
      expect(day.status).toBe(200);
      expect(day.body.includes('Fixture post')).toBe(true);

      const days = await get(url, '/days/');
      expect(days.status).toBe(200);
      expect(days.body.includes(POST_DAY)).toBe(true);

      const post = await get(url, '/r/LocalLLaMA/comments/fix000/');
      expect(post.status).toBe(200);
      expect(post.body.includes('Fixture post')).toBe(true);

      const rss = await get(url, '/rss.xml');
      expect(rss.status).toBe(200);
      expect(rss.type).toBe('application/rss+xml');
      expect(rss.body.includes('<?xml')).toBe(true);
      expect(rss.body.includes(`http://127.0.0.1:${new URL(url).port}/`)).toBe(true);

      const status = await get(url, '/status.json');
      expect(status.status).toBe(200);
      const parsed = JSON.parse(status.body.toString()) as { posts: number; newestSightingMs: number };
      expect(parsed.posts).toBe(2);
      expect(parsed.newestSightingMs > 0).toBe(true);

      const index = await get(url, '/index.json');
      expect((JSON.parse(index.body.toString()) as { posts: unknown[] }).posts.length).toBe(2);

      const missing = await get(url, '/definitely/not/here/');
      expect(missing.status).toBe(404);

      const noTrailingSlash = await get(url, '/hot');
      expect(noTrailingSlash.status).toBe(200);
      expect(noTrailingSlash.body.includes('Fixture post')).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 30000);

  it('the server applies a base prefix when asked', async () => {
    const { child, url } = await startServe(['--base', '/redtap']);
    try {
      const home = await get(url, '/redtap/');
      expect(home.status).toBe(200);
      expect(home.body.includes('href="/redtap/')).toBe(true);
      expect(home.body.includes('href="/hot/')).toBe(false);
    } finally {
      child.kill('SIGTERM');
    }
  }, 30000);

  it('the server ingests a sealed v1 segment and shows it on the feed', async () => {
    const watchDir = join(await mkdtemp(), 'redtap-outbox');
    const now = new Date();
    mkdirSync(join(watchDir, 'v1', 'log', ...now.toISOString().slice(0, 10).split('-')), { recursive: true });
    const { child, mirror, url } = await startServe(['--watch-dir', watchDir]);
    try {
      const record = {
        ...fixtureRecords()[0]!,
        observation_id: 'obs-ingest',
        post_id: 't3_fixingest',
        title: 'Ingested fixture post',
        captured_at: Date.now(),
        metrics: { score: 7, comments: 1, upvote_ratio: 0.8 },
      };
      const lines = await toV1Lines([record], new Set(), digest);
      const stamp = String(now.getTime()).padStart(13, '0');
      const segPath = `v1/log/${now.toISOString().slice(0, 10).replace(/-/g, '/')}/${stamp}-${randomUUID()}.jsonl.gz`;
      const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      const { gzipSync } = await import('node:zlib');
      const gz = gzipSync(Buffer.from(text));
      writeFileSync(join(watchDir, segPath), gz);

      // the watcher picks the segment up, uploads it into the local mirror,
      // and deletes the handoff file
      let mirrorSeg: string | null = null;
      for (let i = 0; i < 20 && mirrorSeg === null; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const segRoot = join(mirror, 'v1', 'log');
        try {
          const files = readdirSync(segRoot, { recursive: true }) as string[];
          const hit = files.map((f) => f.replaceAll('\\', '/')).find((f) => f.endsWith('.jsonl.gz'));
          if (hit) {
            const bytes = readFileSync(join(segRoot, hit));
            if (gunzipSync(bytes).toString().includes('t3_fixingest')) mirrorSeg = hit;
          }
        } catch {
          // mirror not populated yet
        }
      }
      expect(mirrorSeg, 'segment was not ingested into the mirror').not.toBeNull();

      // the ingest triggers a data refresh: the front page shows the new post
      await new Promise((r) => setTimeout(r, 1500));
      const home = await get(url, '/');
      expect(home.body.includes('Ingested fixture post')).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 30000);
});
