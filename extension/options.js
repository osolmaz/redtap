const urlEl = document.getElementById('pool-url');
const tokenEl = document.getElementById('pool-token');
const savedEl = document.getElementById('saved');

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
