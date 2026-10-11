// @ts-nocheck
// redtap control channel — the worker polls a control JSON that lives in
// the pool bucket itself (v1/control.json). Written from outside with
// `hf buckets cp`. The reload flag keeps its loop guard: identical
// documents never re-trigger.

import { downloadFile } from './vendor/index.mjs';
import { ControlDocSchema, type ControlDoc } from './schema.ts';

export const CONTROL_ALARM = 'redtap-control-poll';
const CONTROL_PATHS = ['v1/control.json'];
const APPLIED_CONTROL_KEY = 'lastAppliedControlDoc';

/** Subset of chrome.storage.local the poll needs (injectable for tests). */
export type ControlStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type ControlConfig = {
  bucketRepo: string;
  hubToken: string;
};

export type ControlAlarmApi = {
  create: (name: string, info: chrome.alarms.AlarmCreateInfo) => void;
  onAlarm: {
    addListener: (listener: (alarm: chrome.alarms.Alarm) => void) => void;
  };
};

export type InitControlOptions = {
  alarmApi?: ControlAlarmApi;
  getConfig: () => Promise<ControlConfig>;
  heartbeat?: (() => Promise<Record<string, unknown>>) | null;
  onFlush?: (() => Promise<number> | number) | null;
};

export function initControl({
  alarmApi = globalThis.chrome.alarms,
  getConfig,
  heartbeat,
  onFlush,
}: InitControlOptions): void {
  alarmApi.create(CONTROL_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  alarmApi.onAlarm.addListener((alarm) => {
    if (alarm.name === CONTROL_ALARM) {
      void poll(getConfig, globalThis.chrome.storage.local, heartbeat, onFlush);
    }
  });
  void poll(getConfig, globalThis.chrome.storage.local, heartbeat, onFlush);
}

async function readControl(config: ControlConfig): Promise<ControlDoc | null> {
  for (const path of CONTROL_PATHS) {
    try {
      const blob = await downloadFile({
        repo: { type: 'bucket', name: config.bucketRepo || 'osolmaz/redtap-data' },
        accessToken: config.hubToken || undefined,
        path,
        xet: false,
      });
      if (blob === null) continue;
      const parsed = ControlDocSchema.loose().safeParse(JSON.parse(await blob.text()));
      if (parsed.success) return parsed.data;
    } catch {
      // unreachable bucket or malformed doc: try the next path
    }
  }
  return null;
}

/** Flush is not loop-guarded: the operator clears the flag when done. */
async function applyFlush(
  control: ControlDoc,
  onFlush: (() => Promise<number> | number) | null,
): Promise<void> {
  if (control.flush !== true || onFlush === null) return;
  try {
    await onFlush();
  } catch {
    // flush failures surface through the pool status, not the poll
  }
}

/** Reload only when the flag document changed since the last applied one. */
async function applyReload(control: ControlDoc, storage: ControlStorage | undefined): Promise<void> {
  if (control.reload !== true) return;
  const stamp = JSON.stringify(control);
  if (storage) {
    const previous = await storage.get(APPLIED_CONTROL_KEY);
    if (previous[APPLIED_CONTROL_KEY] === stamp) return;
    await storage.set({ [APPLIED_CONTROL_KEY]: stamp });
  }
  // A fresh worker forgets in-memory guards; the stamp in storage is the
  // loop guard that keeps an unchanged flag document from looping.
  globalThis.chrome.runtime.reload();
}

export async function poll(
  getConfig: () => Promise<ControlConfig>,
  storage: ControlStorage | undefined = globalThis.chrome.storage.local,
  _heartbeat: (() => Promise<Record<string, unknown>>) | null = null,
  onFlush: (() => Promise<number> | number) | null = null,
): Promise<void> {
  let config: ControlConfig | null = null;
  try {
    config = await getConfig();
  } catch {
    return;
  }
  if (config.bucketRepo === '') return;
  const control = await readControl(config);
  if (control === null) return;
  await applyFlush(control, onFlush);
  await applyReload(control, storage);
}
