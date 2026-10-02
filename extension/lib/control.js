// redtap remote control: poll a control document from the pool Space and
// execute simple instructions (currently: reload the service worker). This
// is how a deployed extension picks up code without anyone touching the
// machine: set the flag file in the bucket, the next poll reloads.

export const CONTROL_ALARM = 'redtap-control-poll';

export function initControl({ alarmApi = globalThis.chrome?.alarms, fetchImpl = globalThis.fetch, getConfig } = {}) {
  if (!alarmApi) return;
  alarmApi.onAlarm.addListener((alarm) => {
    if (alarm.name !== CONTROL_ALARM) return;
    void poll(getConfig, fetchImpl);
  });
  alarmApi.create(CONTROL_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
}

export async function poll(getConfig, fetchImpl = globalThis.fetch) {
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
  try {
    const response = await fetchImpl(poolUrl.replace(/\/$/, '') + '/api/control', {
      headers: { authorization: 'Bearer ' + poolToken },
    });
    if (!response.ok) return;
    const control = await response.json();
    if (control?.reload === true) {
      globalThis.chrome.runtime.reload();
    }
  } catch {
    // unreachable Space or transient failure: try again next poll
  }
}
