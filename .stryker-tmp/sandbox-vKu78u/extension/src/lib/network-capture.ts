// @ts-nocheck
// redtap network capture: passive tap on Reddit API responses via the Chrome
// debugger API. Port of xTap's lib/graphql-capture.js: attach to every reddit
// tab, tap JSON responses that carry post data, normalize them through
// postsFromApiPayload, and hand the records to the capture pipeline. Reddit
// ships post bodies and comment trees only on post endpoints, so the tap is
// how browsing captures full-fidelity content with zero extra requests.

const MAX_PENDING_RESPONSES = 10_000;
export const REDTAP_URL_PATTERNS = ['*://*.reddit.com/*', '*://reddit.com/*'];

function assertCaptureDeps(debuggerApi: DebuggerApi | undefined, onResponse: unknown): void {
  if (debuggerApi === undefined) throw new Error('Chrome debugger capture is unavailable');
  if (typeof onResponse !== 'function') throw new Error('GraphQL response handler is required');
}

/** Minimal structural type for the chrome.debugger debugger API (injectable). */
export type DebuggerApi = {
  onEvent: {
    addListener: (
      listener: (source: chrome.debugger.Debuggee, method: string, params?: object) => void,
    ) => void;
  };
  onDetach: {
    addListener: (listener: (source: chrome.debugger.Debuggee) => void) => void;
  };
  sendCommand: (
    target: chrome.debugger.Debuggee,
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Promise<object | undefined>;
};

/** Minimal structural type for chrome.tabs (injectable). */
export type TabsApi = {
  onUpdated: {
    addListener: (
      listener: (tabId: number, changeInfo: { url?: string; status?: string }, tab: { url?: string }) => void,
    ) => void;
  };
  onRemoved: { addListener: (listener: (tabId: number) => void) => void };
  query: (query: { url?: string | string[] }) => Promise<{ id?: number; url?: string }[]>;
};

export type TappedResponse = {
  data: unknown;
  endpoint: string;
  sourceTabId: number | undefined;
  url: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyAttachedError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes('another debugger is already attached');
}

/** The requestId of a CDP network event, when present. */
function requestIdOf(params: unknown): string | null {
  const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
  return typeof requestId === 'string' ? requestId : null;
}

/** Only the three CDP network events this tap follows. */
function isNetworkEvent(method: string): boolean {
  return (
    method === 'Network.responseReceived' ||
    method === 'Network.loadingFailed' ||
    method === 'Network.loadingFinished'
  );
}

function isRedditHostname(hostname: string): boolean {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com');
}

function isRedditUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return isRedditHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isRedditJsonUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!isRedditHostname(parsed.hostname)) return false;
    return parsed.pathname.endsWith('.json');
  } catch {
    return false;
  }
}

function decodeResponseBody(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('Response body is unavailable');
  const v = value as { body?: unknown; base64Encoded?: unknown };
  if (typeof v.body !== 'string') throw new Error('Response body is unavailable');
  return v.base64Encoded === true ? atob(v.body) : v.body;
}

function responseKey(tabId: number, requestId: string): string {
  return `${tabId}:${requestId}`;
}

type PendingResponse = {
  url: string;
};

export class NetworkCapture {
  private readonly debuggerApi: DebuggerApi;
  private readonly tabs: TabsApi;
  private readonly onResponse: (response: TappedResponse) => Promise<void> | void;
  private readonly logger: Console;
  private readonly attachedTabs = new Set<number>();
  private readonly attachmentRevisions = new Map<number, number>();
  private readonly attachments = new Map<number, Promise<void>>();
  private readonly pendingResponses = new Map<string, PendingResponse>();

  constructor({
    debuggerApi = globalThis.chrome.debugger,
    tabs = globalThis.chrome.tabs,
    onResponse,
    logger = console,
  }: {
    debuggerApi?: DebuggerApi;
    tabs?: TabsApi;
    onResponse: (response: TappedResponse) => Promise<void> | void;
    logger?: Console;
  }) {
    assertCaptureDeps(debuggerApi, onResponse);
    this.debuggerApi = debuggerApi;
    this.tabs = tabs;
    this.onResponse = onResponse;
    this.logger = logger;
  }

  attach(): void {
    this.debuggerApi.onEvent.addListener((source, method, params) => {
      void this.handleEvent(source, method, params).catch((error: unknown) => {
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

  async attachExistingTabs(): Promise<void> {
    const tabs = await this.tabs.query({ url: REDTAP_URL_PATTERNS });
    await Promise.all(
      tabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === 'number' && Number.isSafeInteger(tabId))
        .map((tabId) => this.ensureAttached(tabId)),
    );
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) {
      const pending = this.attachments.get(tabId);
      if (pending) await pending;
      return;
    }
    const revision = (this.attachmentRevisions.get(tabId) ?? 0) + 1;
    this.attachmentRevisions.set(tabId, revision);
    this.attachedTabs.add(tabId);
    const attach = this.debuggerApi
      .sendCommand({ tabId }, 'Debugger.enable', {})
      .then(async () => {
        await this.debuggerApi.sendCommand({ tabId }, 'Network.enable', {});
        this.logger.log(`[redtap] attached to tab ${tabId}`);
      })
      .catch((error: unknown) => {
        if (!isAlreadyAttachedError(error)) {
          this.logger.warn(`[redtap] attach failed for tab ${tabId}: ${errorMessage(error)}`);
        }
        this.attachedTabs.delete(tabId);
      });
    this.attachments.set(tabId, attach);
    await attach;
  }

  async detachTab(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    const revision = (this.attachmentRevisions.get(tabId) ?? 0) + 1;
    this.attachmentRevisions.set(tabId, revision);
    this.attachedTabs.delete(tabId);
    this.deletePendingForTab(tabId);
    try {
      await this.debuggerApi.sendCommand({ tabId }, 'Debugger.disable', {});
      this.logger.log(`[redtap] detached from tab ${tabId}`);
    } catch {
      // the tab is likely already gone
    }
  }

  private async handleEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): Promise<void> {
    const tabId = this.tappedTabId(source);
    if (tabId === null) return;
    if (!isNetworkEvent(method)) return;
    const requestId = requestIdOf(params);
    if (requestId === null) return;
    const key = responseKey(tabId, requestId);
    if (method === 'Network.responseReceived') {
      this.rememberJsonResponse(key, params as Record<string, unknown>);
      return;
    }
    if (method === 'Network.loadingFailed') {
      this.pendingResponses.delete(key);
      return;
    }
    await this.deliverFinishedResponse(tabId, key);
  }

  /** The tab this event belongs to, when the tap is still attached to it. */
  private tappedTabId(source: chrome.debugger.Debuggee): number | null {
    const tabId = source.tabId;
    if (tabId === undefined || !this.attachedTabs.has(tabId)) return null;
    return tabId;
  }

  /** The tapped url may ride on the response or the request record. */
  private rememberJsonResponse(key: string, p: Record<string, unknown>): void {
    const response = p.response as { url?: unknown } | undefined;
    const request = p.request as { url?: unknown } | undefined;
    const url = [response?.url, request?.url].find((u) => typeof u === 'string');
    if (typeof url === 'string' && isRedditJsonUrl(url)) this.rememberPending(key, { url });
  }

  private async deliverFinishedResponse(tabId: number, key: string): Promise<void> {
    const pending = this.pendingResponses.get(key);
    if (pending === undefined) return;
    this.pendingResponses.delete(key);
    let data: unknown;
    try {
      const body = await this.debuggerApi.sendCommand({ tabId }, 'Network.getResponseBody', {});
      data = JSON.parse(decodeResponseBody(body)) as unknown;
    } catch (error) {
      this.logger.warn(`[redtap] Could not read tapped response: ${errorMessage(error)}`);
      return;
    }
    let sourceEndpoint = '/api/tap';
    try {
      sourceEndpoint = new URL(pending.url).pathname;
    } catch {
      // keep the default endpoint
    }
    await this.onResponse({
      data,
      endpoint: sourceEndpoint,
      sourceTabId: tabId,
      url: pending.url,
    });
  }

  private rememberPending(key: string, response: PendingResponse): void {
    this.pendingResponses.set(key, response);
    if (this.pendingResponses.size <= MAX_PENDING_RESPONSES) return;
    const oldestKey = this.pendingResponses.keys().next().value;
    if (oldestKey !== undefined) this.pendingResponses.delete(oldestKey);
  }

  private deletePendingForTab(tabId: number): void {
    const prefix = `${tabId}:`;
    for (const key of this.pendingResponses.keys()) {
      if (key.startsWith(prefix)) this.pendingResponses.delete(key);
    }
  }
}
