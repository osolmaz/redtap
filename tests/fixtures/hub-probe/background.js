import { uploadFile } from './probe-lib.js';

self.runProbe = (respond) => {
  const mark = (step) => chrome.storage.local.get('steps').then((b) => chrome.storage.local.set({ steps: [...(b.steps ?? []), step + '@' + new Date().toISOString().slice(11, 19)] }));
  (async () => {
    try {
      await mark('start');
      const bag = await chrome.storage.local.get('token');
      await mark('token loaded');
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout 45s')), 45000));
      const work = uploadFile({
        repo: { type: 'bucket', name: 'osolmaz/redtap-data' },
        accessToken: bag.token,
        file: { path: 'probe/' + Date.now() + '-worker-direct-write.json', content: new Blob([JSON.stringify({ probe: 'worker-direct-write', at: new Date().toISOString() })]) },
        commitTitle: 'probe: direct write from mv3 worker',
      }).then((r) => { void mark('upload resolved'); return r; });
      await Promise.race([work, timeout]);
      await chrome.storage.local.set({ probeResult: { ok: true, at: Date.now() } });
      respond({ ok: true });
    } catch (e) {
      await mark('error: ' + String(e?.message ?? e).slice(0, 120));
      await chrome.storage.local.set({ probeResult: { ok: false, error: String(e?.message ?? e).slice(0, 300) } });
      respond({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  })();
};
