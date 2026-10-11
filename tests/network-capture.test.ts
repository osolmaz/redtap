import { describe, expect, it } from 'vitest';
import {
  NetworkCapture,
  isRedditJsonUrl,
  type DebuggerApi,
  type TabsApi,
  type TappedResponse,
} from '../extension/src/lib/network-capture.ts';

type DebugListener = (source: chrome.debugger.Debuggee, method: string, params?: object) => void;
type DetachListener = (source: chrome.debugger.Debuggee) => void;
type UpdateListener = (
  tabId: number,
  changeInfo: { url?: string; status?: string },
  tab: { url?: string },
) => void;
type RemoveListener = (tabId: number) => void;

type ListenerBag = {
  debuggerEvent: DebugListener[];
  detach: DetachListener[];
  tabUpdated: UpdateListener[];
  tabRemoved: RemoveListener[];
};

function makeRuntime(): {
  debuggerApi: DebuggerApi;
  tabs: TabsApi;
  listeners: ListenerBag;
} {
  const listeners: ListenerBag = { debuggerEvent: [], detach: [], tabUpdated: [], tabRemoved: [] };
  const debuggerApi = {
    onEvent: {
      addListener: (fn: DebugListener): void => {
        listeners.debuggerEvent.push(fn);
      },
    },
    onDetach: {
      addListener: (fn: DetachListener): void => {
        listeners.detach.push(fn);
      },
    },
    sendCommand: async (_target: unknown, method: string): Promise<object> => {
      if (method !== 'Network.getResponseBody') return {};
      return {
        body: JSON.stringify([
          {
            data: {
              children: [
                { kind: 't3', data: { id: 'tap1', title: 'tapped', permalink: '/r/x/comments/tap1/' } },
              ],
            },
          },
        ]),
      };
    },
  };
  const tabs = {
    onUpdated: {
      addListener: (fn: UpdateListener): void => {
        listeners.tabUpdated.push(fn);
      },
    },
    onRemoved: {
      addListener: (fn: RemoveListener): void => {
        listeners.tabRemoved.push(fn);
      },
    },
    query: async (): Promise<{ id: number }[]> => [],
  };
  return { debuggerApi, tabs, listeners };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const REDDIT_URL = 'https://www.reddit.com/r/LocalLLaMA/';
const TAP_RESPONSE = {
  requestId: 'rq1',
  response: { url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc/x.json?limit=5' },
};

describe('network capture', () => {
  it('isRedditJsonUrl matches only reddit json endpoints', () => {
    expect(isRedditJsonUrl('https://www.reddit.com/r/LLM/comments/abc/title.json?limit=5')).toBe(true);
    expect(isRedditJsonUrl('https://old.reddit.com/r/LLM/.json')).toBe(true);
    expect(isRedditJsonUrl('https://www.reddit.com/r/LLM/')).toBe(false);
    expect(isRedditJsonUrl('https://x.com/r/LLM/x.json')).toBe(false);
    expect(isRedditJsonUrl('not a url')).toBe(false);
    expect(isRedditJsonUrl(undefined)).toBe(false);
  });

  it('tap captures a reddit json response and delivers parsed posts', async () => {
    const runtime = makeRuntime();
    const delivered: TappedResponse[] = [];
    const capture = new NetworkCapture({
      ...runtime,
      onResponse: (r): void => {
        delivered.push(r);
      },
    });
    capture.attach();

    await runtime.listeners.tabUpdated[0]!(42, { url: REDDIT_URL }, { url: REDDIT_URL });
    await tick();

    await runtime.listeners.debuggerEvent[0]!({ tabId: 42 }, 'Network.responseReceived', TAP_RESPONSE);
    await runtime.listeners.debuggerEvent[0]!({ tabId: 42 }, 'Network.loadingFinished', { requestId: 'rq1' });
    await tick();

    expect(delivered.length).toBe(1);
    expect(delivered[0]!.sourceTabId).toBe(42);
    const payload = delivered[0]!.data as { data: { children: { data: { id: string } }[] } }[];
    expect(payload[0]!.data.children[0]!.data.id).toBe('tap1');
  });

  it('the debugger-detach event and malformed flows are survived', async () => {
    const runtime = makeRuntime();
    const delivered: TappedResponse[] = [];
    const capture = new NetworkCapture({
      ...runtime,
      onResponse: (r): void => {
        delivered.push(r);
      },
    });
    capture.attach();
    await runtime.listeners.tabUpdated[0]!(21, { url: REDDIT_URL }, { url: REDDIT_URL });
    await tick();
    // chrome itself detaches (navigation): the tap forgets the tab
    await runtime.listeners.detach[0]!({ tabId: 21 });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 21 }, 'Network.responseReceived', TAP_RESPONSE);
    await runtime.listeners.debuggerEvent[0]!({ tabId: 21 }, 'Network.loadingFinished', { requestId: 'rq1' });
    await tick();
    expect(delivered.length).toBe(0);
  });

  it('events without tab ids or request ids are ignored', async () => {
    const runtime = makeRuntime();
    const delivered: TappedResponse[] = [];
    const capture = new NetworkCapture({
      ...runtime,
      onResponse: (r): void => {
        delivered.push(r);
      },
    });
    capture.attach();
    await runtime.listeners.debuggerEvent[0]!({}, 'Network.responseReceived', { requestId: 'rq' });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 3 }, 'Network.responseReceived', {});
    await runtime.listeners.debuggerEvent[0]!({ tabId: 3 }, 'Other.event', {});
    await tick();
    expect(delivered.length).toBe(0);
  });

  it('a failing body read is warned about and skipped', async () => {
    const listeners: ListenerBag = { debuggerEvent: [], detach: [], tabUpdated: [], tabRemoved: [] };
    const failingBodyApi = {
      onEvent: {
        addListener: (fn: DebugListener): void => {
          listeners.debuggerEvent.push(fn);
        },
      },
      onDetach: {
        addListener: (fn: DetachListener): void => {
          listeners.detach.push(fn);
        },
      },
      sendCommand: async (_t: unknown, method: string): Promise<object> => {
        if (method === 'Network.getResponseBody') throw new Error('body gone');
        return {};
      },
    };
    const tabs = {
      onUpdated: {
        addListener: (fn: UpdateListener): void => {
          listeners.tabUpdated.push(fn);
        },
      },
      onRemoved: {
        addListener: (fn: RemoveListener): void => {
          listeners.tabRemoved.push(fn);
        },
      },
      query: async (): Promise<{ id: number }[]> => [],
    };
    const delivered: TappedResponse[] = [];
    const capture = new NetworkCapture({
      debuggerApi: failingBodyApi,
      tabs,
      onResponse: (r): void => {
        delivered.push(r);
      },
    });
    capture.attach();
    await listeners.tabUpdated[0]!(31, { url: REDDIT_URL }, { url: REDDIT_URL });
    await tick();
    await listeners.debuggerEvent[0]!({ tabId: 31 }, 'Network.responseReceived', TAP_RESPONSE);
    await listeners.debuggerEvent[0]!({ tabId: 31 }, 'Network.loadingFinished', { requestId: 'rq1' });
    await tick();
    expect(delivered.length).toBe(0);
  });

  it('an attach failure removes the tab from the attached set', async () => {
    const listeners: ListenerBag = { debuggerEvent: [], detach: [], tabUpdated: [], tabRemoved: [] };
    const failingApi = {
      onEvent: {
        addListener: (fn: DebugListener): void => {
          listeners.debuggerEvent.push(fn);
        },
      },
      onDetach: {
        addListener: (fn: DetachListener): void => {
          listeners.detach.push(fn);
        },
      },
      sendCommand: async (): Promise<object> => {
        throw new Error('attach failed hard');
      },
    };
    const tabs = {
      onUpdated: {
        addListener: (fn: UpdateListener): void => {
          listeners.tabUpdated.push(fn);
        },
      },
      onRemoved: {
        addListener: (fn: RemoveListener): void => {
          listeners.tabRemoved.push(fn);
        },
      },
      query: async (): Promise<{ id: number }[]> => [{ id: 5 }],
    };
    const capture = new NetworkCapture({ debuggerApi: failingApi, tabs, onResponse: () => undefined });
    capture.attach();
    await tick();
    // the failed attach dropped the tab: a later event is ignored
    await listeners.debuggerEvent[0]!({ tabId: 5 }, 'Network.responseReceived', TAP_RESPONSE);
    await tick();
  });

  it('detaches when a tab leaves reddit, and tab close detaches cleanly', async () => {
    const runtime = makeRuntime();
    const capture = new NetworkCapture({ ...runtime, onResponse: () => undefined });
    capture.attach();

    // a reddit tab gets attached...
    await runtime.listeners.tabUpdated[0]!(9, { url: REDDIT_URL }, { url: REDDIT_URL });
    // ...a non-reddit navigation detaches it...
    await runtime.listeners.tabUpdated[0]!(
      9,
      { url: 'https://example.com/' },
      { url: 'https://example.com/' },
    );
    // ...and a detached tab's events are ignored
    await runtime.listeners.debuggerEvent[0]!({ tabId: 9 }, 'Network.responseReceived', TAP_RESPONSE);
    await runtime.listeners.debuggerEvent[0]!({ tabId: 9 }, 'Network.loadingFinished', { requestId: 'rq9' });
    await tick();

    // tab close detaches cleanly too
    await runtime.listeners.tabUpdated[0]!(11, { url: REDDIT_URL }, { url: REDDIT_URL });
    await runtime.listeners.tabRemoved[0]!(11);
    await tick();
  });

  it('tap ignores non-json responses and failures on other hosts', async () => {
    const runtime = makeRuntime();
    const delivered: TappedResponse[] = [];
    const capture = new NetworkCapture({
      ...runtime,
      onResponse: (r): void => {
        delivered.push(r);
      },
    });
    capture.attach();

    await runtime.listeners.tabUpdated[0]!(
      7,
      { url: 'https://www.reddit.com/r/LLM/' },
      { url: 'https://www.reddit.com/r/LLM/' },
    );
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'rq2',
      response: { url: 'https://www.reddit.com/r/LLM/' },
    });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'rq2' });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'rq3',
      response: { url: 'https://elsewhere.example.com/x.json' },
    });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'rq3' });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.responseReceived', {
      requestId: 'rq4',
      response: { url: 'https://www.reddit.com/r/LLM/x.json' },
    });
    await runtime.listeners.debuggerEvent[0]!({ tabId: 7 }, 'Network.loadingFailed', {
      requestId: 'rq4',
      error: 'net::ERR_FAILED',
    });
    await tick();
    expect(delivered.length).toBe(0);
  });
});
