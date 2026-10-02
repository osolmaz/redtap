import test from 'node:test';
import assert from 'node:assert/strict';

import { NetworkCapture, isRedditJsonUrl } from '../extension/lib/network-capture.js';

function makeRuntime() {
  const listeners = { debuggerEvent: [], detach: [], tabUpdated: [], tabRemoved: [] };
  const debuggerApi = {
    onEvent: { addListener: (fn) => listeners.debuggerEvent.push(fn) },
    onDetach: { addListener: (fn) => listeners.detach.push(fn) },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (target, method) => {
      if (method !== 'Network.getResponseBody') return {};
      return { body: JSON.stringify([{ data: { children: [{ kind: 't3', data: { id: 'tap1', title: 'tapped', permalink: '/r/x/comments/tap1/' } }] } }]) };
    },
  };
  const tabs = {
    onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
    onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
    query: async () => [],
  };
  return { debuggerApi, tabs, listeners };
}

test('isRedditJsonUrl matches only reddit json endpoints', () => {
  assert.equal(isRedditJsonUrl('https://www.reddit.com/r/LLM/comments/abc/title.json?limit=5'), true);
  assert.equal(isRedditJsonUrl('https://old.reddit.com/r/LLM/.json'), true);
  assert.equal(isRedditJsonUrl('https://www.reddit.com/r/LLM/'), false);
  assert.equal(isRedditJsonUrl('https://x.com/r/LLM/x.json'), false);
  assert.equal(isRedditJsonUrl('not a url'), false);
  assert.equal(isRedditJsonUrl(undefined), false);
});

test('tap captures a reddit json response and delivers parsed posts', async () => {
  const runtime = makeRuntime();
  const delivered = [];
  const capture = new NetworkCapture({ ...runtime, onResponse: (r) => delivered.push(r) });
  capture.attach();

  await runtime.listeners.tabUpdated[0](42, { url: 'https://www.reddit.com/r/LocalLLaMA/' }, { url: 'https://www.reddit.com/r/LocalLLaMA/' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await runtime.listeners.debuggerEvent[0](
    { tabId: 42 },
    'Network.responseReceived',
    { requestId: 'rq1', response: { url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc/x.json?limit=5' } },
  );
  await runtime.listeners.debuggerEvent[0]({ tabId: 42 }, 'Network.loadingFinished', { requestId: 'rq1' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sourceTabId, 42);
  assert.equal(delivered[0].data[0].data.children[0].data.id, 'tap1');
});

test('tap ignores non-json responses and failures on other hosts', async () => {
  const runtime = makeRuntime();
  const delivered = [];
  const capture = new NetworkCapture({ ...runtime, onResponse: (r) => delivered.push(r) });
  capture.attach();

  await runtime.listeners.tabUpdated[0](7, { url: 'https://www.reddit.com/r/LLM/' }, {});
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.responseReceived', { requestId: 'rq2', response: { url: 'https://www.reddit.com/r/LLM/' } });
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'rq2' });
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.responseReceived', { requestId: 'rq3', response: { url: 'https://elsewhere.example.com/x.json' } });
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'rq3' });
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.responseReceived', { requestId: 'rq4', response: { url: 'https://www.reddit.com/r/LLM/x.json' } });
  await runtime.listeners.debuggerEvent[0]({ tabId: 7 }, 'Network.loadingFailed', { requestId: 'rq4', error: 'net::ERR_FAILED' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(delivered.length, 0);
});
