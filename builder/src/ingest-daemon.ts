#!/usr/bin/env node
// redtap ingest daemon (runs as bob): watches ~/Downloads/redtap-outbox/ for
// sealed v1 segments dropped by the extension's downloads handoff and uploads
// each to the HF bucket, then deletes the file. No service units; started with
// setsid nohup.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The vendored hub bundle lives in the repo checkout the daemon is deployed
// next to; the absolute path is the deployment contract.
const VENDOR_HUB = '/home/bob/repos/redtap/extension/lib/vendor/index.mjs';
const { uploadFile } = (await import(VENDOR_HUB)) as {
  uploadFile: (params: {
    repo: { type: 'bucket'; name: string };
    accessToken: string | undefined;
    file: { path: string; content: Blob };
    commitTitle?: string;
  }) => Promise<unknown>;
};

const ROOT = '/home/bob/Downloads/redtap-outbox';
const TOKEN = readFileSync('/tmp/rt-hf-token', 'utf-8').trim();
const REPO = { type: 'bucket' as const, name: 'osolmaz/redtap-data' };
const SEGMENT = /^v1\/log\/\d{4}\/\d{2}\/\d{2}\/\d{13}-[0-9a-z-]{30,40}\.jsonl\.gz$/;
const inFlight = new Set<string>();

async function ingestFile(absPath: string, relPath: string): Promise<void> {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    const gz = readFileSync(absPath);
    await uploadFile({
      repo: REPO,
      accessToken: TOKEN,
      file: { path: relPath, content: new Blob([new Uint8Array(gz)]) },
      commitTitle: 'redtap: sealed v1 segment',
    });
    console.log(new Date().toISOString(), 'ingested', relPath, gz.length, 'bytes');
    rmSync(absPath);
  } catch (error) {
    const msg = String((error as Error | undefined)?.message ?? error);
    const status = (error as { status?: number } | undefined)?.status;
    if (status === 409 || msg.includes('409')) {
      console.log(new Date().toISOString(), 'already committed', relPath);
      rmSync(absPath);
    } else {
      console.log(new Date().toISOString(), 'FAIL', relPath, msg.slice(0, 160));
    }
  } finally {
    inFlight.delete(relPath);
  }
}

function scan(): void {
  if (!existsSync(ROOT)) return;
  let found: string[] = [];
  try {
    found = readdirSync(join(ROOT, 'v1', 'log'), { recursive: true }) as string[];
  } catch {
    return;
  }
  for (const rel of found) {
    const norm = rel.replaceAll('\\', '/');
    if (!SEGMENT.test('v1/log/' + norm)) continue;
    void ingestFile(join(ROOT, 'v1', 'log', rel), 'v1/log/' + norm);
  }
}

scan();
setInterval(scan, 20_000);
console.log(new Date().toISOString(), 'ingest daemon watching', ROOT);
