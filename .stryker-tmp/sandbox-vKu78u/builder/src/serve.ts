#!/usr/bin/env node
// @ts-nocheck
// Local redtap server: serves the same rendered site as build-site.ts, on
// demand, with no build step. Pick the data source with one flag:
//
//   node builder/src/serve.ts --backend local --dir ~/scratch/redtap-data
//   node builder/src/serve.ts --backend hf                    (private HF bucket)
//
// Defaults: --host 0.0.0.0 (reachable over Tailscale), --port 8088.
// The HF token comes from --token, $HF_TOKEN, or ~/.cache/huggingface/token,
// in that order, and is never logged. Restart the server to reload data.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { extname, join, normalize, dirname as pathDirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { DEFAULT_BUCKET, renderRoute, siteState, withBase, type SiteState } from './site-lib.ts';
import { uploadFile } from '@huggingface/hub';

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    dir: { type: 'string' },
    bucket: { type: 'string' },
    token: { type: 'string' },
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '8088' },
    base: { type: 'string', default: '' },
    'watch-dir': { type: 'string' },
  },
  strict: false,
});

const strArg = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const dir = strArg(values.dir);
const backend = strArg(values.backend) ?? (dir ? 'local' : 'hf');
if (backend !== 'hf' && backend !== 'local') {
  console.error(`unknown backend "${backend}" — use "hf" or "local"`);
  process.exit(2);
}
if (backend === 'local' && (!dir || !existsSync(dir))) {
  console.error(
    'backend "local" needs --dir pointing at a folder that holds v1/log/ segments (a bucket-root mirror works)',
  );
  process.exit(2);
}

function hfToken(): string | undefined {
  const explicit = strArg(values.token) ?? process.env.HF_TOKEN;
  if (explicit) return explicit;
  const cached = join(homedir(), '.cache', 'huggingface', 'token');
  if (existsSync(cached)) return readFileSync(cached, 'utf-8').trim();
  return undefined;
}

const source =
  backend === 'local'
    ? { kind: 'local' as const, dir: dir ?? '' }
    : {
        kind: 'hf' as const,
        repo: process.env.RT_BUCKET ?? strArg(values.bucket) ?? DEFAULT_BUCKET,
        token: hfToken(),
      };

const HOST = strArg(values.host) ?? '0.0.0.0';
const PORT = Number(strArg(values.port) ?? '8088');
const BASE = strArg(values.base) ?? '';

// Capture ingest: the extension hands sealed v1 segments to the downloads
// folder via chrome.downloads; the server watches it and performs the bucket
// write from node, where the hub client is proven.
const WATCH_ROOT = strArg(values['watch-dir']) ?? join(homedir(), 'Downloads', 'redtap-outbox');
const SEGMENT_PATH = /^v1\/log\/\d{4}\/\d{2}\/\d{2}\/\d{13}-[0-9a-z-]{30,40}\.jsonl\.gz$/;
const inFlight = new Set<string>();

/** Mirror the segment into a local backend folder. */
function storeLocalSegment(root: string, relPath: string, gz: Buffer): void {
  const file = join(root, relPath);
  mkdirSync(pathDirname(file), { recursive: true });
  writeFileSync(file, gz);
}

function segmentLineCount(gz: Buffer): number {
  return gunzipSync(gz).toString('utf-8').trim().split('\n').filter(Boolean).length;
}

async function ingestFile(absPath: string, relPath: string): Promise<void> {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    const gz = readFileSync(absPath);
    const lines = segmentLineCount(gz);
    if (source.kind === 'hf') {
      await uploadSegment(source, relPath, gz);
    } else {
      storeLocalSegment(source.dir, relPath, gz);
    }
    console.error(`ingested ${relPath} (${lines} lines)`);
    rmSync(absPath);
    await refreshState();
  } catch (error) {
    ingestFailed(absPath, relPath, error);
  } finally {
    inFlight.delete(relPath);
  }
}

/** 409 means already committed: drop the handoff either way; retry otherwise. */
function ingestFailed(absPath: string, relPath: string, error: unknown): void {
  const raw = (error as Error | undefined)?.message;
  const message = raw ?? JSON.stringify(error);
  if (message.includes('409')) {
    console.error(`ingest ${relPath}: already committed, dropping`);
    rmSync(absPath);
    return;
  }
  console.error(`ingest ${relPath} failed, will retry on next event: ${message.slice(0, 140)}`);
}

async function uploadSegment(
  source: { repo: string; token?: string },
  relPath: string,
  gz: Buffer,
): Promise<void> {
  await uploadFile({
    repo: { type: 'bucket', name: source.repo },
    accessToken: source.token,
    file: { path: relPath, content: new Blob([new Uint8Array(gz)]) },
    commitTitle: 'redtap: ingest segment',
  });
}

function startIngestWatcher(): void {
  mkdirSync(WATCH_ROOT, { recursive: true });
  const scan = (): void => {
    let found: string[] = [];
    try {
      found = readdirSync(join(WATCH_ROOT, 'v1', 'log'), { recursive: true }) as string[];
    } catch {
      return;
    }
    for (const rel of found) {
      const norm = rel.replaceAll('\\', '/');
      if (!SEGMENT_PATH.test('v1/log/' + norm)) continue;
      void ingestFile(join(WATCH_ROOT, 'v1', 'log', rel), 'v1/log/' + norm);
    }
  };
  scan();
  try {
    watch(WATCH_ROOT, { recursive: true }, () => setTimeout(scan, 1500)).unref();
  } catch (e) {
    console.error(`watching ${WATCH_ROOT} failed:`, e);
  }
  setInterval(scan, 60_000).unref();
  console.error(`watching ${WATCH_ROOT} for sealed segments`);
}

console.error(`loading data from the ${backend} backend…`);
let state: SiteState = await siteState(source, { base: BASE });
console.error(`${state.summaries.length} posts ready`);

// keep the feed alive: re-read the backend periodically so new sightings
// show up without a restart, and never age pages against a stale clock
const REFRESH_MS = 5 * 60_000;
async function refreshState(): Promise<void> {
  try {
    state = await siteState(source, { base: BASE });
    console.error(`data refreshed — ${state.summaries.length} posts`);
  } catch (err) {
    console.error('data refresh failed, serving the previous snapshot:', err);
  }
}
setInterval(() => {
  refreshState().catch(() => undefined);
}, REFRESH_MS).unref();
startIngestWatcher();

const STATIC_ROOT = join(here, '..', '..', 'space', 'static');

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.xml': 'application/rss+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.txt': 'text/plain',
};

function serveStatic(pathname: string): { type: string; body: Buffer } | null {
  const rel = normalize(pathname.slice('/static/'.length)).replace(/^(\.\.\/)+/, '');
  if (!rel || rel.startsWith('..')) return null;
  const file = join(STATIC_ROOT, rel);
  if (!file.startsWith(STATIC_ROOT) || !existsSync(file)) return null;
  const bytes = readFileSync(file);
  return { type: TYPES[extname(file)] ?? 'application/octet-stream', body: bytes };
}

function notFound() {
  return {
    type: 'text/html',
    body: withBase(
      '<!doctype html><html><head><meta charset="utf-8"><title>not found — redtap</title></head><body><p>Nothing at this address. <a href="/">Back to the front page.</a></p></body></html>',
      BASE,
    ),
  };
}

/** Strip the base prefix and normalize the trailing slash. */
function stripBase(pathname: string): string {
  if (BASE !== '') {
    if (pathname === BASE || pathname === BASE + '/') return '/';
    if (pathname.startsWith(BASE + '/')) return pathname.slice(BASE.length);
  }
  return pathname;
}

function requestPath(raw: string | undefined): { pathname: string; searchParams: URLSearchParams } | null {
  try {
    const parsed = new URL(raw ?? '/', 'http://localhost');
    let pathname = stripBase(decodeURIComponent(parsed.pathname));
    if (!pathname.endsWith('/') && extname(pathname) === '') pathname += '/';
    return { pathname, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

/** The date form GETs ?from=&to= (and friends) onto the scope path; non-empty
 * params fill gaps in the path-derived query, like the Space. */
function queryOverrides(searchParams: URLSearchParams): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const key of ['from', 'to', 'sort', 'range', 'subreddit']) {
    const value = searchParams.get(key);
    if (value !== null) overrides[key] = value;
  }
  return overrides;
}

function respond(req: IncomingMessage, res: ServerResponse): void {
  const parsed = requestPath(req.url);
  if (parsed === null) {
    res.writeHead(400).end('bad request');
    return;
  }
  const { pathname } = parsed;
  try {
    // absolute links inside the feed follow the host the visitor used, so
    // they work the same over localhost and Tailscale
    const siteUrl = `http://${req.headers.host ?? 'localhost'}${BASE}`;
    const rendered = pathname.startsWith('/static/')
      ? serveStatic(pathname)
      : renderRoute(pathname, { ...state, siteUrl, now: Date.now() }, queryOverrides(parsed.searchParams));
    if (rendered === null) {
      const nf = notFound();
      res.writeHead(404, { 'content-type': nf.type }).end(nf.body);
      return;
    }
    res.writeHead(200, { 'content-type': rendered.type }).end(rendered.body);
  } catch (error) {
    console.error('render failed for', pathname, String((error as Error | undefined)?.message ?? error));
    res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
  }
}

const server = createServer((req, res): void => {
  respond(req, res);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  // machine-readable for tests and scripts: parse this stdout line
  console.log(`redtap-serve listening on http://${displayHost}:${actualPort}${BASE}/`);
  console.error(
    `bound to ${HOST}:${actualPort} — reachable from your Tailnet on this machine's Tailscale IP`,
  );
});
