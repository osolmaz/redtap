// redtap remote control: poll a control document from the pool Space and
// execute simple instructions (currently: reload the service worker). This
// is how a deployed extension picks up code without anyone touching the
// machine: set the flag file in the bucket, the next poll reloads.

export const CONTROL_ALARM = 'redtap-control-poll';

export function initControl({ alarmApi = globalThis.chrome?.alarms, fetchImpl = globalThis.fetch, getConfig, heartbeat } = {}) {
  if (!alarmApi) return;
  alarmApi.onAlarm.addListener((alarm) => {
    if (alarm.name !== CONTROL_ALARM) return;
    void poll(getConfig, fetchImpl, globalThis.chrome?.storage?.local, heartbeat);
  });
  alarmApi.create(CONTROL_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
}

async function sendTelemetry(fetchImpl, poolUrl, poolToken, heartbeat) {
  try {
    if (typeof heartbeat !== 'function') return;
    const state = await heartbeat();
    if (!state) return;
    await fetchImpl(poolUrl.replace(/\/$/, '') + '/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + poolToken },
      body: JSON.stringify({ at: Date.now(), ...state }),
    });
  } catch {
    // telemetry is best-effort
  }
}

const APPLIED_CONTROL_KEY = 'lastAppliedControlDoc';

export async function poll(getConfig, fetchImpl = globalThis.fetch, storage = globalThis.chrome?.storage?.local, heartbeat = null) {
  let poolUrl = '';
  let poolToken = '';
  try {
    const config = await getConfig();
    poolUrl = typeof config?.poolUrl === 'string' ? config.poolUrl : '';
    poolToken = typeof config?.poolToken === 'string' ? config.poolToken : '';
  } catch {
    return;
  }
  if (!poolUrl || !poolToken) return;
  await sendTelemetry(fetchImpl, poolUrl, poolToken, heartbeat);
  try {
    const response = await fetchImpl(poolUrl.replace(/\/$/, '') + '/api/control', {
      headers: { authorization: 'Bearer ' + poolToken },
    });
    if (!response.ok) return;
    const control = await response.json();
    if (control?.reload !== true) return;
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
  } catch {
    // unreachable Space or transient failure: try again next poll
  }
}
