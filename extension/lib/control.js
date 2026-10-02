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

const RELOAD_GUARD_KEY = 'lastControlReloadAtMs';
const RELOAD_GUARD_MS = 10 * 60_000;

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
    // Loop guard: a stale flag file in the bucket must not cause an endless
    // reload cycle. Only honor the flag once per guard window.
    if (storage) {
      const bag = await storage.get(RELOAD_GUARD_KEY);
      const last = bag[RELOAD_GUARD_KEY];
      if (typeof last === 'number' && Date.now() - last < RELOAD_GUARD_MS) return;
      await storage.set({ [RELOAD_GUARD_KEY]: Date.now() });
    }
    globalThis.chrome.runtime.reload();
  } catch {
    // unreachable Space or transient failure: try again next poll
  }
}
