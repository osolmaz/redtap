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
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DEFAULT_BUCKET, renderRoute, siteState, withBase } from './site-lib.mjs';

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

console.error(`loading data from the ${backend} backend…`);
const state = await siteState(source, { base: BASE });
console.error(`${state.summaries.length} posts ready`);

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
      : renderRoute(pathname, { ...state, siteUrl }, overrides);
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
