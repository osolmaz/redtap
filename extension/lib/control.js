// redtap control channel — the worker polls a control JSON that lives in
// the pool bucket itself (v1/control.json, then the legacy v1 path during
// the transition). Written from outside with `hf buckets cp`. The reload
// flag keeps its loop guard: identical documents never re-trigger.

import { downloadFile } from './vendor/index.mjs';

const CONTROL_PATHS = ['v1/control.json'];
const APPLIED_CONTROL_KEY = 'lastAppliedControlDoc';

export function initControl({ alarmApi = globalThis.chrome?.alarms, fetchImpl = globalThis.fetch, getConfig, heartbeat } = {}) {
  if (!alarmApi) return;
  alarmApi.create(CONTROL_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  alarmApi.onAlarm.addListener((alarm) => {
    if (alarm.name === CONTROL_ALARM) {
      void poll(getConfig, fetchImpl, globalThis.chrome?.storage?.local, heartbeat);
    }
  });
  void poll(getConfig, fetchImpl, globalThis.chrome?.storage?.local, heartbeat);
}

export const CONTROL_ALARM = 'redtap-control-poll';

async function readControl(config) {
  for (const path of CONTROL_PATHS) {
    try {
      const blob = await downloadFile({
        repo: { type: 'bucket', name: config.bucketRepo || 'osolmaz/redtap-data' },
        accessToken: config.hubToken || undefined,
        path,
        xet: false,
      });
      if (blob === null) continue;
      const parsed = JSON.parse(await blob.text());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

export async function poll(getConfig, fetchImpl = globalThis.fetch, storage = globalThis.chrome?.storage?.local, heartbeat = null) {
  let config = null;
  try {
    config = await getConfig();
  } catch {
    return;
  }
  if (!config || !config.bucketRepo) return;
  void fetchImpl;
  const control = await readControl(config);
  if (!control || control?.reload !== true) return;
  // Loop guard: the flag file outlives the worker, and a fresh worker
  // forgets in-memory guards. Reload only when the flag document actually
  // changed since the last applied one; identical flag = no-op.
  const stamp = JSON.stringify(control);
  if (storage) {
    const bag = await storage.get(APPLIED_CONTROL_KEY);
    if (bag[APPLIED_CONTROL_KEY] === stamp) return;
    await storage.set({ [APPLIED_CONTROL_KEY]: stamp });
  }
  globalThis.chrome.runtime.reload();
}
