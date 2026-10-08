import { chromium } from '/home/onur/repos/solmazio/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs';
import { readFileSync } from 'node:fs';

// The write probe: load the fixture extension in a real headless Chrome and
// commit one small object to the bucket from the MV3 worker. Skips with
// code 0-style pass-through when no token file exists (CI without secrets).
const tokenPath = process.env.RT_HF_TOKEN_FILE ?? '/home/onur/.cache/huggingface/token';
let token;
try {
  token = readFileSync(tokenPath, 'utf8').trim();
} catch {
  console.log('PROBE SKIPPED: no token file at', tokenPath);
  process.exit(0);
}
const context = await chromium.launchPersistentContext('/tmp/rt-hub-probe/profile', {
  headless: true,
  channel: 'chromium',
  args: ['--headless=new', '--disable-extensions-except=/tmp/rt-hub-probe', '--load-extension=/tmp/rt-hub-probe'],
});
const worker = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
await new Promise((r) => setTimeout(r, 2000));
const sw = worker ?? context.serviceWorkers()[0];
if (!sw) { console.log('NO SERVICE WORKER'); process.exit(1); }
console.log('SW url:', sw.url());
await sw.evaluate((t) => chrome.storage.local.set({ token: t }), token);
console.log('token set, sending message (no respond expected fast)...');
sw.evaluate(() => new Promise((resolve) => self.runProbe((r) => resolve(r ?? 'null-reply')))).then((r) => console.log('DIRECT REPLY:', JSON.stringify(r))).catch((e) => console.log('direct call error:', String(e).slice(0, 120)));
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const bag = await sw.evaluate(() => chrome.storage.local.get(['steps', 'probeResult']));
  console.log(i, 'steps:', JSON.stringify(bag.steps ?? []), 'result:', JSON.stringify(bag.probeResult ?? null));
  if (bag.probeResult) break;
}
await context.close();
