const urlEl = document.getElementById('bucket-repo');
const tokenEl = document.getElementById('hub-token');
const subsEl = document.getElementById('pool-subs');
const savedEl = document.getElementById('saved');

// Remote-ops hook: opening this page with ?selfreload=1 reloads the
// extension (picks up new code) without anyone touching the mouse.
if (new URLSearchParams(location.search).has('selfreload')) {
  document.getElementById('saved').textContent = 'Reloading extension…';
  setTimeout(() => chrome.runtime.reload(), 300);
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
