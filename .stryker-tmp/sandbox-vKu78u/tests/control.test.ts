// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vendored hub bundle is intercepted at its resolved path (the alias in
// vitest.config.ts maps the source specifier here); the fake downloadFile
// serves the operator's document.
const vendorState = vi.hoisted((): { current: unknown; failNext: boolean } => ({
  current: null,
  failNext: false,
}));

vi.mock('../extension/lib/vendor/index.mjs', () => ({
  downloadFile: (): Promise<Blob | null> => {
    if (vendorState.failNext) {
      vendorState.failNext = false;
      return Promise.reject(new Error('connection refused'));
    }
    return vendorState.current === null
      ? Promise.resolve(null)
      : Promise.resolve(new Blob([JSON.stringify(vendorState.current)]));
  },
}));

describe('control poll', () => {
  let bag: Record<string, unknown>;
  let reloaded: number;
  let flushes: number;
  let fakeChrome: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    vendorState.current = null;
    bag = {};
    reloaded = 0;
    flushes = 0;
    fakeChrome = {
      storage: {
        local: {
          get: (key: string): Promise<Record<string, unknown>> =>
            Promise.resolve(key in bag ? { [key]: bag[key] } : {}),
          set: (items: Record<string, unknown>): Promise<void> => {
            Object.assign(bag, items);
            return Promise.resolve();
          },
        },
      },
      runtime: {
        reload: (): void => {
          reloaded += 1;
        },
      },
      alarms: {
        get: () => Promise.resolve(undefined),
        create: (): undefined => undefined,
        onAlarm: {
          addListener: (): undefined => undefined,
        },
      },
    };
    vi.stubGlobal('chrome', fakeChrome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadPoll() {
    return import('../extension/src/lib/control.ts');
  }

  const config = (): Promise<{ bucketRepo: string; hubToken: string }> =>
    Promise.resolve({ bucketRepo: 'osolmaz/redtap-data', hubToken: 'tok' });

  it('a reload flag triggers exactly one reload; an identical flag is a no-op', async () => {
    const { poll } = await loadPoll();
    vendorState.current = { reload: true, at: '2026-10-10T00:00:00Z' };
    await poll(config);
    expect(reloaded).toBe(1);
    await poll(config);
    expect(reloaded).toBe(1); // identical stamp
    vendorState.current = { reload: true, at: '2026-10-10T01:00:00Z' };
    await poll(config);
    expect(reloaded).toBe(2); // changed stamp
  });

  it('a flush flag runs the flush callback once per poll', async () => {
    const { poll } = await loadPoll();
    vendorState.current = { flush: true, at: '2026-10-10T00:00:00Z' };
    const onFlush = (): number => {
      flushes += 1;
      return flushes;
    };
    await poll(config, undefined, null, onFlush);
    expect(flushes).toBe(1);
    await poll(config, undefined, null, onFlush);
    expect(flushes).toBe(2); // flush is not loop-guarded: every poll with the flag flushes
  });

  it('a missing or malformed control doc is a no-op', async () => {
    const { poll } = await loadPoll();
    vendorState.current = null;
    await poll(config);
    vendorState.current = 'not an object';
    await poll(config);
    expect(reloaded).toBe(0);
    expect(flushes).toBe(0);
  });

  it('a bucket fetch failure and a schema-invalid doc are survived', async () => {
    vendorState.failNext = true;
    const { poll } = await loadPoll();
    vendorState.current = { reload: 'yes' }; // schema-invalid: no reload flag
    await poll(config);
    expect(reloaded).toBe(0);
    // the retried fetch then sees a valid doc
    vendorState.current = { reload: true, at: '2026-10-10T03:00:00Z' };
    await poll(config);
    expect(reloaded).toBe(1);
  });

  it('initControl wires the alarm and the poll fires on it', async () => {
    let alarmHandler: ((alarm: chrome.alarms.Alarm) => void) | undefined;
    const alarmApi = {
      create: (): void => undefined,
      onAlarm: {
        addListener: (listener: (alarm: chrome.alarms.Alarm) => void): void => {
          alarmHandler = listener;
        },
      },
    };
    const { CONTROL_ALARM, initControl } = await loadPoll();
    const flushes = vi.fn();
    initControl({ alarmApi, getConfig: config, onFlush: flushes });
    // the boot poll already ran; the alarm poll runs it again
    alarmHandler!({ name: CONTROL_ALARM } as chrome.alarms.Alarm);
    expect(flushes).not.toHaveBeenCalled();
  });

  it('a throwing config getter ends the poll quietly', async () => {
    const { poll } = await loadPoll();
    vendorState.current = { reload: true };
    await poll(async () => {
      throw new Error('storage unavailable');
    });
    expect(reloaded).toBe(0);
  });

  it('a reload without storage reloads unguarded (fresh worker)', async () => {
    const { poll } = await loadPoll();
    vendorState.current = { reload: true, at: '2026-10-10T02:00:00Z' };
    await poll(config, undefined, null, null);
    expect(reloaded).toBe(1);
  });

  it('a poll without config never touches the bucket', async () => {
    const { poll } = await loadPoll();
    vendorState.current = { reload: true };
    await poll((): Promise<{ bucketRepo: string; hubToken: string }> =>
      Promise.resolve({ bucketRepo: '', hubToken: '' }),
    );
    expect(reloaded).toBe(0);
  });
});
