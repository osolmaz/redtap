const urlEl = document.getElementById('pool-url');
const tokenEl = document.getElementById('pool-token');
const savedEl = document.getElementById('saved');

// Remote-ops hook: opening this page with ?selfreload=1 reloads the
// extension (picks up new code) without anyone touching the mouse.
if (new URLSearchParams(location.search).has('selfreload')) {
  document.getElementById('saved').textContent = 'Reloading extension…';
  setTimeout(() => chrome.runtime.reload(), 300);
}

chrome.storage.local.get(['poolUrl', 'poolToken']).then((bag) => {
  urlEl.value = bag.poolUrl ?? '';
  tokenEl.value = bag.poolToken ?? '';
});

document.getElementById('save').addEventListener('click', () => {
  const config = { poolUrl: urlEl.value.trim(), poolToken: tokenEl.value.trim() };
  chrome.runtime.sendMessage({ type: 'redtap:pool-config', config }, () => {
    savedEl.textContent = 'Saved. Pool sync will flush within a minute.';
  });
});
