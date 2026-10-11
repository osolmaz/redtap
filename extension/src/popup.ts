// redtap popup: capture status and manual sync.

export {};

type PoolStatus = {
  synced?: number;
  queued?: number;
  subs?: string[];
  lastError?: string | null;
};

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const statusEl = requireEl('status');
const observationsEl = requireEl('observations-count');
const uniqueEl = requireEl('unique-count');
const subredditsEl = requireEl('subreddit-count');
const currentEl = requireEl('current');
const exportBtn = requireEl('export') as HTMLButtonElement;
const exportStatusEl = requireEl('export-status');
const poolStatusEl = requireEl('pool-status');
const syncNowEl = requireEl('pool-sync-now') as HTMLButtonElement;

// Counts come from the pool sync state; the local archive is gone (the
// bucket's v1 log is the archive).
function renderCounts(): void {
  chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status: PoolStatus | undefined) => {
    observationsEl.textContent = String(status?.synced ?? 0);
    uniqueEl.textContent = '—';
    subredditsEl.textContent = String(status?.subs?.length ?? 0);
  });
}

async function renderCurrentTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    const match = /reddit\.com\/r\/([A-Za-z0-9_]+)/.exec(url);
    if (match !== null) {
      statusEl.textContent = 'Capturing';
      statusEl.className = 'status connected';
      currentEl.innerHTML = `Scraping <b>r/${match[1]}</b> right now`;
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
    currentEl.textContent = '';
  }
}

/** The last-error line, when the pool is unhappy. */
function errorSuffix(lastError: string | null | undefined): string {
  return lastError === null || lastError === undefined ? '' : ` · ${lastError}`;
}

function renderPool(status: PoolStatus | undefined): void {
  const s = status ?? {};
  if (s.queued === undefined && s.synced === undefined) {
    poolStatusEl.textContent = 'Pool not configured';
    poolStatusEl.className = 'status disconnected';
    return;
  }
  const healthy = s.lastError === null || s.lastError === undefined;
  poolStatusEl.textContent = `Queued ${s.queued ?? 0} · synced ${s.synced ?? 0}` + errorSuffix(s.lastError);
  poolStatusEl.className = healthy ? 'status connected' : 'status disconnected';
}

renderCounts();
chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status: PoolStatus | undefined) => {
  renderPool(status);
});
void renderCurrentTab();

syncNowEl.addEventListener('click', () => {
  syncNowEl.disabled = true;
  chrome.runtime.sendMessage({ type: 'redtap:pool-flush-now' }, () => {
    syncNowEl.disabled = false;
    chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status: PoolStatus | undefined) => {
      renderPool(status);
    });
  });
});

function markExportsRemoved(): void {
  exportBtn.disabled = true;
  try {
    exportStatusEl.style.display = 'block';
    exportStatusEl.textContent = 'Exports removed — the bucket serves the data';
    exportStatusEl.className = 'status connected';
  } finally {
    exportBtn.disabled = false;
  }
}

requireEl('export-all').addEventListener('click', markExportsRemoved);
exportBtn.addEventListener('click', markExportsRemoved);
