const statusEl = document.getElementById('status');
const observationsEl = document.getElementById('observations-count');
const uniqueEl = document.getElementById('unique-count');
const subredditsEl = document.getElementById('subreddit-count');
const currentEl = document.getElementById('current');
const exportBtn = document.getElementById('export');
const exportStatusEl = document.getElementById('export-status');
const poolStatusEl = document.getElementById('pool-status');
const syncNowEl = document.getElementById('pool-sync-now');

// Counts come from the pool sync state; the local archive is gone (the
// bucket's v2 log is the archive).
function renderCounts() {
  chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status) => {
    observationsEl.textContent = String(status?.synced ?? 0);
    uniqueEl.textContent = '—';
    subredditsEl.textContent = String(status?.subs?.length ?? 0);
  });
}

async function renderCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    const match = /reddit\\.com\\/r\\/([A-Za-z0-9_]+)/.exec(url);
    if (match) {
      statusEl.textContent = 'Capturing';
      statusEl.className = 'status connected';
      currentEl.innerHTML = 'Scraping <b>r/' + match[1] + '</b> right now';
    } else if (url.includes('reddit.com')) {
      statusEl.textContent = 'Capturing';
      statusEl.className = 'status connected';
      currentEl.innerHTML = 'On <b>reddit.com</b>';
    } else {
      statusEl.textContent = 'Not on Reddit';
      statusEl.className = 'status disconnected';
      currentEl.textContent = '';
    }
  } catch {
    statusEl.textContent = 'Idle';
    statusEl.className = 'status disconnected';
  }
}

function renderPool(status) {
  if (!status.configured) {
    poolStatusEl.textContent = 'Not configured — open Options';
    poolStatusEl.className = 'status disconnected';
  } else if (status.paused) {
    poolStatusEl.textContent = 'Paused';
    poolStatusEl.className = 'status disconnected';
  } else {
    poolStatusEl.textContent = 'Queued ' + status.queued + ' · synced ' + status.synced + (status.lastError ? ' · ' + status.lastError : '');
    poolStatusEl.className = 'status ' + (status.lastError ? 'disconnected' : 'connected');
  }
}

renderCounts();
chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status) => renderPool(status ?? {}));
renderCurrentTab();

syncNowEl.addEventListener('click', () => {
  syncNowEl.disabled = true;
  chrome.runtime.sendMessage({ type: 'redtap:pool-flush-now' }, (response) => {
    syncNowEl.disabled = false;
    chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status) => renderPool(status ?? {}));
  });
});

const exportAllEl = document.getElementById('export-all');
exportAllEl.addEventListener('click', async () => {
  exportAllEl.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'redtap:export', uniqueOnly: false });
    exportStatusEl.style.display = 'block';
    exportStatusEl.textContent = 'Exports removed — the bucket serves the data';
    exportStatusEl.className = 'status connected';
  } finally {
    exportAllEl.disabled = false;
  }
});

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  try {
    exportStatusEl.style.display = 'block';
    exportStatusEl.textContent = 'Exports removed — the bucket serves the data';
    exportStatusEl.className = 'status connected';
  } finally {
    exportBtn.disabled = false;
  }
});
