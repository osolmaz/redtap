// redtap network capture: passive tap on Reddit API responses via the Chrome
// debugger API. Port of xTap's lib/graphql-capture.js: attach to every reddit
// tab, tap JSON responses that carry post data, normalize them through
// postsFromApiPayload, and hand the records to the capture pipeline. Reddit
// ships post bodies and comment trees only on post endpoints, so the tap is
// how browsing captures full-fidelity content with zero extra requests.

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const MAX_PENDING_RESPONSES = 10_000;
const REDTAP_URL_PATTERNS = ['*://*.reddit.com/*', '*://reddit.com/*'];

export class NetworkCapture {
  constructor({
    debuggerApi = globalThis.chrome?.debugger,
    tabs = globalThis.chrome?.tabs,
    onResponse,
    logger = console,
  } = {}) {
    if (!debuggerApi || !tabs) throw new Error('Chrome debugger capture is unavailable');
    if (typeof onResponse !== 'function') throw new Error('GraphQL response handler is required');
    this.debuggerApi = debuggerApi;
    this.tabs = tabs;
    this.onResponse = onResponse;
    this.logger = logger;
    this.attachedTabs = new Set();
    this.attachmentRevisions = new Map();
    this.attachments = new Map();
    this.pendingResponses = new Map();
  }

  attach() {
    this.debuggerApi.onEvent.addListener((source, method, params) => {
      void this.handleEvent(source, method, params).catch((error) => {
        this.logger.error('[redtap] Passive Reddit capture failed:', error);
      });
    });
    this.debuggerApi.onDetach.addListener((source) => {
      if (source.tabId === undefined) return;
      this.attachedTabs.delete(source.tabId);
      this.attachments.delete(source.tabId);
      this.deletePendingForTab(source.tabId);
    });
    this.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const url = changeInfo.url ?? tab.url;
      if (isRedditUrl(url)) {
        void this.ensureAttached(tabId);
      } else if (changeInfo.url || changeInfo.status === 'loading') {
        void this.detachTab(tabId);
      }
    });
    this.tabs.onRemoved.addListener((tabId) => {
      void this.detachTab(tabId);
    });
    void this.attachExistingTabs();
  }

  async attachExistingTabs() {
    const tabs = await this.tabs.query({ url: REDTAP_URL_PATTERNS });
    await Promise.all(
      tabs
        .map((tab) => tab.id)
        .filter((tabId) => Number.isSafeInteger(tabId))
        .map((tabId) => this.ensureAttached(tabId)),
    );
  }

  async ensureAttached(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
    if (this.attachedTabs.has(tabId)) return true;
    const pending = this.attachments.get(tabId);
    if (pending) return pending;
    const revision = this.attachmentRevisions.get(tabId) ?? 0;
    const attaching = this.attachTab(tabId, revision).finally(() => {
      if (this.attachments.get(tabId) === attaching) this.attachments.delete(tabId);
    });
    this.attachments.set(tabId, attaching);
    return attaching;
  }

  async attachTab(tabId, revision) {
    let attachedHere = false;
    try {
      await this.debuggerApi.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      attachedHere = true;
    } catch (error) {
      if (!isAlreadyAttachedError(error)) {
        this.logger.warn(`[redtap] Could not observe reddit tab ${tabId}: ${errorMessage(error)}`);
        return false;
      }
    }
    try {
      await this.debuggerApi.sendCommand({ tabId }, 'Network.enable');
      if ((this.attachmentRevisions.get(tabId) ?? 0) !== revision) {
        if (attachedHere) await this.safeDetach(tabId);
        return false;
      }
      this.attachedTabs.add(tabId);
      return true;
    } catch (error) {
      if (attachedHere) await this.safeDetach(tabId);
      this.logger.warn(`[redtap] Could not enable capture for reddit tab ${tabId}: ${errorMessage(error)}`);
      return false;
    }
  }

  async detachTab(tabId) {
    const revision = (this.attachmentRevisions.get(tabId) ?? 0) + 1;
    this.attachmentRevisions.set(tabId, revision);
    const pending = this.attachments.get(tabId);
    if (pending) await pending;
    this.deletePendingForTab(tabId);
    if (!this.attachedTabs.delete(tabId)) return;
    await this.safeDetach(tabId);
  }

  async safeDetach(tabId) {
    try {
      await this.debuggerApi.detach({ tabId });
    } catch {
      // Chrome may have already detached a closed or reassigned tab.
    }
  }

  async handleEvent(source, method, params) {
    const tabId = source.tabId;
    if (!Number.isSafeInteger(tabId)) return;
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    const key = responseKey(tabId, requestId);

    if (method === 'Network.responseReceived') {
      const url = params?.response?.url;
      if (isRedditJsonUrl(url)) {
        this.rememberPending(key, { requestId, tabId, url });
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      this.pendingResponses.delete(key);
      return;
    }
    if (method !== 'Network.loadingFinished') return;

    const pending = this.pendingResponses.get(key);
    if (!pending) return;
    this.pendingResponses.delete(key);
    let data;
    try {
      const body = await this.debuggerApi.sendCommand(
        { tabId },
        'Network.getResponseBody',
        { requestId },
      );
      data = JSON.parse(decodeResponseBody(body));
    } catch (error) {
      this.logger.warn(`[redtap] Could not read tapped response: ${errorMessage(error)}`);
      return;
    }
    let sourceEndpoint = '/api/tap';
    try {
      sourceEndpoint = new URL(pending.url).pathname;
    } catch {}
    await this.onResponse({
      data,
      endpoint: sourceEndpoint,
      sourceTabId: tabId,
      url: pending.url,
    });
  }

  rememberPending(key, response) {
    this.pendingResponses.set(key, response);
    if (this.pendingResponses.size <= MAX_PENDING_RESPONSES) return;
    const oldestKey = this.pendingResponses.keys().next().value;
    if (oldestKey !== undefined) this.pendingResponses.delete(oldestKey);
  }

  deletePendingForTab(tabId) {
    const prefix = `${tabId}:`;
    for (const key of this.pendingResponses.keys()) {
      if (key.startsWith(prefix)) this.pendingResponses.delete(key);
    }
  }
}

export function isRedditJsonUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!isRedditHostname(parsed.hostname)) return false;
    return parsed.pathname.endsWith('.json');
  } catch {
    return false;
  }
}

function decodeResponseBody(value) {
  if (!value || typeof value.body !== 'string') throw new Error('Response body is unavailable');
  return value.base64Encoded === true ? atob(value.body) : value.body;
}

function isRedditUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return isRedditHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isRedditHostname(hostname) {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com');
}

function isAlreadyAttachedError(error) {
  return errorMessage(error).toLowerCase().includes('another debugger is already attached');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function responseKey(tabId, requestId) {
  return `${tabId}:${requestId}`;
}
