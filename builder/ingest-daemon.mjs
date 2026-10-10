#!/usr/bin/env node
// redtap ingest daemon (runs as bob): watches ~/Downloads/redtap-outbox/ for
// sealed v1 segments dropped by the extension's downloads handoff and uploads
// each to the HF bucket, then deletes the file. No service units; started with
// setsid nohup.
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { uploadFile } from '/home/bob/repos/redtap/extension/lib/vendor/index.mjs';

const ROOT = '/home/bob/Downloads/redtap-outbox';
const TOKEN = readFileSync('/tmp/rt-hf-token', 'utf-8').trim();
const REPO = { type: 'bucket', name: 'osolmaz/redtap-data' };
const SEGMENT = /^v1\/log\/\d{4}\/\d{2}\/\d{2}\/\d{13}-[0-9a-z-]{30,40}\.jsonl\.gz$/;
const inFlight = new Set();

async function ingestFile(absPath, relPath) {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    const gz = readFileSync(absPath);
    await uploadFile({ repo: REPO, accessToken: TOKEN, file: { path: relPath, content: new Blob([gz]) }, commitTitle: 'redtap: sealed v1 segment' });
    console.log(new Date().toISOString(), 'ingested', relPath, gz.length, 'bytes');
    rmSync(absPath);
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (error?.status === 409 || /409/.test(msg)) {
      console.log(new Date().toISOString(), 'already committed', relPath);
      rmSync(absPath);
    } else {
      console.log(new Date().toISOString(), 'FAIL', relPath, msg.slice(0, 160));
    }
  } finally {
    inFlight.delete(relPath);
  }
}

function scan() {
  if (!existsSync(ROOT)) return;
  let found = [];
  try { found = readdirSync(join(ROOT, 'v1', 'log'), { recursive: true }); } catch { return; }
  for (const rel of found) {
    const norm = rel.replaceAll('\\\\', '/');
    if (!SEGMENT.test('v1/log/' + norm)) continue;
    ingestFile(join(ROOT, 'v1', 'log', rel), 'v1/log/' + norm);
  }
}

scan();
setInterval(scan, 20_000);
console.log(new Date().toISOString(), 'ingest daemon watching', ROOT);
