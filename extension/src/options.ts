// redtap options page: bucket config + remote-ops hooks.

export {};

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const urlEl = requireEl('bucket-repo') as HTMLInputElement;
const tokenEl = requireEl('hub-token') as HTMLInputElement;
const subsEl = requireEl('pool-subs') as HTMLInputElement;
const savedEl = requireEl('saved');

// Remote-ops hooks: ?selfreload=1 reloads the options page (soft);
// ?hardreload=1 calls chrome.runtime.reload() immediately, which forces
// Chrome to drop its cached extension modules and re-read from disk.
const params = new URLSearchParams(location.search);
if (params.has('hardreload') || params.has('selfreload')) {
  savedEl.textContent = params.has('hardreload') ? 'Hard-reloading extension…' : 'Reloading extension…';
  setTimeout(
    (): void => {
      chrome.runtime.reload();
    },
    params.has('hardreload') ? 100 : 300,
  );
}

// Remote-ops hook: ?debug=1 renders the worker's live pool status so the
// capture pipeline can be inspected headlessly; ?flush=1 also triggers a
// seal right away.
if (params.has('debug') || params.has('flush')) {
  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  const flush = document.createElement('button');
  flush.textContent = 'Flush now';
  flush.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'redtap:pool-flush-now' }, (r: { flushed?: number } | undefined) => {
      pre.textContent = `flushed ${r?.flushed ?? '?'} lines`;
    });
  });
  document.body.append(flush, pre);
  const poll = (): void => {
    chrome.runtime.sendMessage({ type: 'redtap:pool-status' }, (status: unknown) => {
      if (chrome.runtime.lastError !== undefined) {
        pre.textContent = chrome.runtime.lastError.message ?? 'status unavailable';
        return;
      }
      pre.textContent = JSON.stringify(status, null, 2);
    });
  };
  poll();
  setInterval(poll, 5000);
  if (params.has('flush'))
    setTimeout((): void => {
      flush.click();
    }, 1500);
}

chrome.storage.local
  .get(['bucketRepo', 'hubToken', 'poolSubs'])
  .then((bag) => {
    urlEl.value =
      typeof bag.bucketRepo === 'string' && bag.bucketRepo !== '' ? bag.bucketRepo : 'osolmaz/redtap-data';
    tokenEl.value = typeof bag.hubToken === 'string' ? bag.hubToken : '';
    subsEl.value = typeof bag.poolSubs === 'string' ? bag.poolSubs : 'LocalLLaMA';
  })
  .catch((): undefined => undefined);

requireEl('save').addEventListener('click', () => {
  const config = {
    bucketRepo: urlEl.value.trim(),
    hubToken: tokenEl.value.trim(),
    subs: subsEl.value
      .split(',')
      .map((s) => s.trim().replace(/^r\//i, ''))
      .filter(Boolean),
  };
  chrome.runtime.sendMessage({ type: 'redtap:pool-config', config }, () => {
    savedEl.textContent = 'Saved. Captures seal into the bucket every 2 hours.';
  });
});
