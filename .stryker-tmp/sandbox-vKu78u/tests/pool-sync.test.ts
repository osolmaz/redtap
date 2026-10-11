// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { ObservationRecord } from '../extension/src/lib/schema.ts';

// The pool-sync module reads chrome lazily through globalThis; a fake chrome
// keeps the whole seal pipeline unit-testable in node.
type StoredBag = Record<string, unknown>;

function makeFakeChrome() {
  const bag: StoredBag = {};
  const downloads: { filename: string; url: string }[] = [];
  const counters = { alarmsCreated: 0 };
  const fake = {
    storage: {
      local: {
        get: async (key: string | string[]): Promise<StoredBag> => {
          const keys = Array.isArray(key) ? key : [key];
          const out: StoredBag = {};
          for (const k of keys) if (k in bag) out[k] = bag[k];
          return out;
        },
        set: async (items: StoredBag): Promise<void> => {
          Object.assign(bag, items);
        },
      },
    },
    alarms: {
      get: () => Promise.resolve(undefined),
      create: (): Promise<void> => {
        counters.alarmsCreated += 1;
        return Promise.resolve();
      },
      onAlarm: {
        addListener: () => undefined,
      },
    },
    downloads: {
      download: async (opts: { url: string; filename: string }): Promise<number> => {
        downloads.push({ filename: opts.filename, url: opts.url });
        return downloads.length;
      },
    },
  };
  return { fake, bag, downloads, counters };
}

const record = (over: Partial<ObservationRecord> = {}): ObservationRecord => ({
  observation_id: 'rt_test001',
  post_id: 't3_seal01',
  post_at: '2026-10-10T00:00:00.000Z',
  captured_at: 1_791_500_000_000,
  source_endpoint: '/api/tap',
  contributed_by: 'tap',
  pooled_at: null,
  title: 'Seal test post',
  author: null,
  subreddit: 'LocalLLaMA',
  permalink: '/r/LocalLLaMA/comments/seal01/',
  content_href: null,
  selftext: 'a seal test body worth storing',
  metrics: { score: 1, comments: 0, upvote_ratio: null },
  ...over,
});

describe('pool sync', () => {
  let env: ReturnType<typeof makeFakeChrome>;

  beforeEach(async () => {
    env = makeFakeChrome();
    vi.stubGlobal('chrome', env.fake);
    // fresh module state per test
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadModule() {
    return import('../extension/src/lib/pool-sync.ts');
  }

  it('initPoolSync registers the seal alarm once and dispatches a pending cycle', async () => {
    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    const pool = await loadModule();
    await pool.initPoolSync({ log: () => Promise.resolve() });
    expect(env.counters.alarmsCreated).toBe(1);
  });

  it('parseSubs normalizes subreddit lists', async () => {
    const { parseSubs } = await loadModule();
    expect(parseSubs('r/LocalLLaMA, askReddit ')).toEqual(['LocalLLaMA', 'askReddit']);
    expect(parseSubs('')).toBeNull();
    expect(parseSubs('  ')).toBeNull();
    expect(parseSubs(undefined)).toBeNull();
  });

  it('admitRecords queues, seals a v1 segment through the downloads handoff, and drains the outbox', async () => {
    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    const pool = await loadModule();

    pool.admitRecords([record()]);
    expect(pool.statusSnapshot().queued).toBe(1);

    const flushed = await pool.flushNowNow();
    expect(flushed).toBe(1);
    expect(env.downloads.length).toBe(1);

    const handoff = env.downloads[0]!;
    expect(handoff.filename).toMatch(
      /^redtap-outbox\/v1\/log\/\d{4}\/\d{2}\/\d{2}\/\d{13}-[0-9a-f-]{36}\.jsonl\.gz$/,
    );
    const b64 = handoff.url.split(',')[1]!;
    const text = gunzipSync(Buffer.from(b64, 'base64')).toString('utf-8');
    expect(text).toContain('t3_seal01');
    expect(text).toContain('a seal test body worth storing');
    expect(text.endsWith('\n')).toBe(true);

    const snap = pool.statusSnapshot();
    expect(snap.queued).toBe(0);
    expect(snap.synced).toBe(1);
    expect(snap.lastError).toBeNull();
    expect(snap.cyclePath).toBeNull();
  });

  it('the seal cycle path persists until the handoff succeeds and resets after', async () => {
    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    const pool = await loadModule();

    pool.admitRecords([record()]);
    await pool.flushNowNow();
    // a second empty force-seal creates no second handoff
    await pool.flushNowNow();
    expect(env.downloads.length).toBe(1);
  });

  it('a failed handoff sets lastError and keeps the outbox buffered', async () => {
    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    // break the downloads handoff for this test
    env.fake.downloads.download = async (): Promise<number> => {
      throw new Error('status 401: bad token');
    };
    const pool = await loadModule();
    pool.admitRecords([record()]);
    expect(await pool.flushNowNow()).toBe(0);
    const snap = pool.statusSnapshot();
    expect(snap.lastError).toContain('auth failed');
    expect(env.downloads.length).toBe(0);
  });

  it('a 429 backoff schedules a retry and a generic error backs off less', async () => {
    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    env.fake.downloads.download = async (): Promise<number> => {
      throw new Error('status 429: slow down');
    };
    const pool = await loadModule();
    pool.admitRecords([record()]);
    expect(await pool.flushNowNow()).toBe(0);
    expect(pool.statusSnapshot().lastError).toContain('429');
  });

  it('sealing is skipped while paused or unconfigured', async () => {
    const pool = await loadModule();
    expect(await pool.flushNowNow()).toBe(0); // unconfigured: no token in storage
    expect(env.downloads.length).toBe(0);

    env.bag.hubToken = 'tok';
    env.bag.bucketRepo = 'osolmaz/redtap-data';
    env.bag.poolPaused = true;
    const pool2 = await loadModule();
    pool2.admitRecords([record()]);
    expect(await pool2.flushNowNow()).toBe(0);
    expect(env.downloads.length).toBe(0);
    expect(pool2.statusSnapshot().paused).toBe(true);
  });
});
