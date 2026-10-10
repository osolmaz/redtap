#!/usr/bin/env node
// Local redtap server: serves the same rendered site as build-site.mjs, on
// demand, with no build step. Pick the data source with one flag:
//
//   node builder/serve.mjs --backend local --dir ~/scratch/redtap-data
//   node builder/serve.mjs --backend hf                    (private HF bucket)
//
// Defaults: --host 0.0.0.0 (reachable over Tailscale), --port 8088.
// The HF token comes from --token, $HF_TOKEN, or ~/.cache/huggingface/token,
// in that order, and is never logged. Restart the server to reload data.

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, watch } from 'node:fs';
import { extname, join, normalize, dirname as pathDirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_BUCKET, renderRoute, siteState, withBase } from './site-lib.mjs';
import { uploadFile } from '@huggingface/hub';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const dir = arg('dir', undefined);
const backend = arg('backend', dir ? 'local' : 'hf');
if (backend !== 'hf' && backend !== 'local') {
  console.error(`unknown backend "${backend}" — use "hf" or "local"`);
  process.exit(2);
}
if (backend === 'local' && (!dir || !existsSync(dir))) {
  console.error('backend "local" needs --dir pointing at a folder that holds v2/log/ segments (a bucket-root mirror works)');
  process.exit(2);
}

const source = backend === 'local'
  ? { kind: 'local', dir }
  : { kind: 'hf', repo: process.env.RT_BUCKET ?? arg('bucket', DEFAULT_BUCKET), token: hfToken() };

function hfToken() {
  const explicit = arg('token', undefined) ?? process.env.HF_TOKEN;
  if (explicit) return explicit;
  const cached = join(homedir(), '.cache', 'huggingface', 'token');
  if (existsSync(cached)) return readFileSync(cached, 'utf-8').trim();
  return undefined;
}

const HOST = arg('host', '0.0.0.0');
const PORT = Number(arg('port', '8088'));
const BASE = arg('base', '');

// Capture ingest: the extension hands sealed v2 segments to the downloads
// folder via chrome.downloads; the server watches it and performs the bucket
// write from node, where the hub client is proven.
const WATCH_ROOT = arg('watch-dir', undefined) ?? join(homedir(), 'Downloads', 'redtap-outbox');
const SEGMENT_PATH = /^v2\/log\/\d{4}\/\d{2}\/\d{2}\/\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl\.gz$/;
const inFlight = new Set();

async function ingestFile(absPath, relPath) {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    const gz = readFileSync(absPath);
    const text = gunzipSync(gz).toString('utf-8');
    const lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (backend === 'local') {
      const file = join(dir, relPath);
      mkdirSync(pathDirname(file), { recursive: true });
      writeFileSync(file, gz);
    } else {
      await uploadFile({
        repo: { type: 'bucket', name: source.repo },
        accessToken: source.token,
        file: { path: relPath, content: new Blob([gz]) },
        commitTitle: `redtap: ingest ${lines.length} v2 lines`,
      });
    }
    console.error(`ingested ${relPath} (${lines.length} lines)`);
    rmSync(absPath);
    refreshState();
  } catch (error) {
    if (String(error?.message ?? '').includes('409')) {
      console.error(`ingest ${relPath}: already committed, dropping`);
      rmSync(absPath);
      return;
    }
    console.error(`ingest ${relPath} failed, will retry on next event: ${String(error?.message ?? error).slice(0, 140)}`);
  } finally {
    inFlight.delete(relPath);
  }
}

function startIngestWatcher() {
  mkdirSync(WATCH_ROOT, { recursive: true });
  const scan = () => {
    let found = [];
    try { found = readdirSync(join(WATCH_ROOT, 'v2', 'log'), { recursive: true }); } catch { return; }
    for (const rel of found) {
      if (!SEGMENT_PATH.test('v2/log/' + rel.replaceAll('\\', '/'))) continue;
      ingestFile(join(WATCH_ROOT, 'v2', 'log', rel), 'v2/log/' + rel.replaceAll('\\', '/'));
    }
  };
  scan();
  try { watch(WATCH_ROOT, { recursive: true }, () => setTimeout(scan, 1500)).unref(); } catch (e) {
    console.error(`watching ${WATCH_ROOT} failed: ${e?.message ?? e}`);
  }
  setInterval(scan, 60_000).unref();
  console.error(`watching ${WATCH_ROOT} for sealed segments`);
}

console.error(`loading data from the ${backend} backend…`);
let state = await siteState(source, { base: BASE });
console.error(`${state.summaries.length} posts ready`);

// keep the feed alive: re-read the backend periodically so new sightings
// show up without a restart, and never age pages against a stale clock
const REFRESH_MS = 5 * 60_000;
async function refreshState() {
  try {
    state = await siteState(source, { base: BASE });
    console.error(`data refreshed — ${state.summaries.length} posts`);
  } catch (err) {
    console.error(`data refresh failed, serving the previous snapshot: ${err?.message ?? err}`);
  }
}
setInterval(refreshState, REFRESH_MS).unref();
startIngestWatcher();

const STATIC_ROOT = join(here, '..', 'space', 'static');
const TYPES = {
  '.html': 'text/html', '.xml': 'application/rss+xml', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.css': 'text/css', '.js': 'text/javascript', '.txt': 'text/plain',
};

function serveStatic(pathname) {
  const rel = normalize(pathname.slice('/static/'.length)).replace(/^(\.\.\/)+/, '');
  if (!rel || rel.startsWith('..')) return null;
  const file = join(STATIC_ROOT, rel);
  if (!file.startsWith(STATIC_ROOT) || !existsSync(file)) return null;
  const bytes = readFileSync(file);
  return { type: TYPES[extname(file)] ?? 'application/octet-stream', body: bytes };
}

function notFound() {
  return { type: 'text/html', body: withBase('<!doctype html><html><head><meta charset="utf-8"><title>not found — redtap</title></head><body><p>Nothing at this address. <a href="/">Back to the front page.</a></p></body></html>', BASE) };
}

const server = createServer((req, res) => {
  let pathname;
  let searchParams;
  try {
    const parsed = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(parsed.pathname);
    searchParams = parsed.searchParams;
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (BASE) {
    if (pathname === BASE || pathname === BASE + '/') pathname = '/';
    else if (pathname.startsWith(BASE + '/')) pathname = pathname.slice(BASE.length);
  }
  if (!pathname.endsWith('/') && !extname(pathname)) pathname += '/';
  try {
    // absolute links inside the feed follow the host the visitor used, so
    // they work the same over localhost and Tailscale
    const siteUrl = `http://${req.headers.host ?? 'localhost'}${BASE}`;
    // the date form GETs ?from=&to= (and friends) onto the scope path;
    // non-empty params fill gaps in the path-derived query, like the Space
    const overrides = {};
    for (const key of ['from', 'to', 'sort', 'range', 'subreddit']) {
      const value = searchParams.get(key);
      if (value) overrides[key] = value;
    }
    const rendered = pathname.startsWith('/static/')
      ? serveStatic(pathname)
      : renderRoute(pathname, { ...state, siteUrl, now: Date.now() }, overrides);
    if (!rendered) {
      const nf = notFound();
      res.writeHead(404, { 'content-type': nf.type }).end(nf.body);
      return;
    }
    res.writeHead(200, { 'content-type': rendered.type }).end(rendered.body);
  } catch (error) {
    console.error('render failed for', pathname, String(error?.message ?? error));
    res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  // machine-readable for tests and scripts: parse this stdout line
  console.log(`redtap-serve listening on http://${displayHost}:${actualPort}${BASE}/`);
  console.error(`bound to ${HOST}:${actualPort} — reachable from your Tailnet on this machine's Tailscale IP`);
});
