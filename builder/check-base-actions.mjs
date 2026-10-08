// Build with a Pages subpath base and assert that form actions and links are
// prefixed. Committed as a script (not a node -e one-liner) so verification
// runners can execute it without shell quoting.
//
// Usage: node builder/check-base-actions.mjs [--space https://osolmaz-redtap-space.hf.space]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spaceIdx = process.argv.indexOf('--space');
const space = (spaceIdx > 0 ? process.argv[spaceIdx + 1] : 'https://osolmaz-redtap-space.hf.space').replace(/\/$/, '');
const out = 'dist-base';

const build = spawnSync(process.execPath, [join(here, 'build-site.mjs'), '--from-space', space, '--base', '/redtap', '--out', out], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('FAILED: build step exited', build.status, build.error ?? '');
  process.exit(1);
}

const html = readFileSync(join(here, out, 'index.html'), 'utf8');
const problems = [];
if (!html.includes('action="/redtap/"')) problems.push('missing prefixed form action');
if (/action="\/(?!redtap)/.test(html)) problems.push('unprefixed root-absolute form action');
if (/href="\/(?!redtap)/.test(html)) problems.push('unprefixed root-absolute href');

if (problems.length > 0) {
  console.error('FAILED:', problems.join('; '));
  process.exit(1);
}
console.log('PASS base-prefixed form actions and links');
