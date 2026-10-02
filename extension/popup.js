const countEl = document.getElementById('count');
const uniqueEl = document.getElementById('unique');
const statusEl = document.getElementById('status');

function render(state) {
  countEl.textContent = String((state.lines ?? []).length);
  const seen = new Set((state.lines ?? []).map((line) => line.post_id));
  uniqueEl.textContent = String(seen.size);
}

chrome.storage.local.get('redtapLines').then((bag) => render({ lines: bag.redtapLines ?? [] }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.redtapLines) render({ lines: changes.redtapLines.newValue ?? [] });
});

document.getElementById('export').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'redtap:export' });
  statusEl.textContent = response?.exported != null ? `exported ${response.exported} posts` : 'export failed';
});
