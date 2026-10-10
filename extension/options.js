const urlEl = document.getElementById('bucket-repo');
const tokenEl = document.getElementById('hub-token');
const subsEl = document.getElementById('pool-subs');
const savedEl = document.getElementById('saved');

// Remote-ops hooks: ?selfreload=1 reloads the options page (soft);
// ?hardreload=1 calls chrome.runtime.reload() immediately, which forces
// Chrome to drop its cached extension modules and re-read from disk.
if (new URLSearchParams(location.search).has('hardreload')) {
  document.getElementById('saved').textContent = 'Hard-reloading extension…';
  setTimeout(() => chrome.runtime.reload(), 100);
} else if (new URLSearchParams(location.search).has('selfreload')) {
  document.getElementById('saved').textContent = 'Reloading extension…';
  setTimeout(() => chrome.runtime.reload(), 300);
}

// Remote-ops hook: ?debug=1 renders the worker's live pool status so the
// capture pipeline can be inspected headlessly; ?flush=1 also triggers a
// seal right away.
if (new URLSearchParams(location.search).has('debug') || new URLSearchParams(location.search).has('flush')) {
  const params = new URLSearchParams(location.search);
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  const flush = document.createElement('button');
  flush.textContent = 'Flush now';
  flush.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'redtap:pool-flush-now' }, (r) => {
      pre.textContent = 'flushed ' + (r?.flushed ?? '?') + ' lines';
    });
  });
  document.body.append(flush, pre);
  const render = (status) => { pre.textContent = JSON.stringify(status, null, 2); };
  const poll = () => chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status) => {
    if (chrome.runtime.lastError) { pre.textContent = chrome.runtime.lastError.message; return; }
    render(status);
  });
  poll();
  setInterval(poll, 5000);
  if (params.has('flush')) setTimeout(() => flush.click(), 1500);
}

chrome.storage.local.get(['bucketRepo', 'hubToken', 'poolSubs']).then((bag) => {
  urlEl.value = bag.bucketRepo ?? 'osolmaz/redtap-data';
  tokenEl.value = bag.hubToken ?? '';
  subsEl.value = bag.poolSubs ?? 'LocalLLaMA';
});

document.getElementById('save').addEventListener('click', () => {
  const config = { bucketRepo: urlEl.value.trim(), hubToken: tokenEl.value.trim(), subs: subsEl.value.split(',').map((s) => s.trim().replace(/^r\//i, '')).filter(Boolean) };
  chrome.runtime.sendMessage({ type: 'redtap:pool-config', config }, () => {
    savedEl.textContent = 'Saved. Captures seal into the bucket every 2 hours.';
  });
});
