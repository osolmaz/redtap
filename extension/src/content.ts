// redtap content script: watches the DOM for shreddit-post elements and sends
// normalized records to the service worker. Runs on every reddit page.
import { extractPostRecord } from './lib/observations.ts';
import type { PostRecord } from './lib/schema.ts';

(function contentScript(): void {
  if ((globalThis as { __redtapContent?: boolean }).__redtapContent === true) return;
  (globalThis as { __redtapContent?: boolean }).__redtapContent = true; // guard against re-injection

  const sourceEndpoint = (): string => location.pathname;

  function extractRecord(element: Element): PostRecord | null {
    return extractPostRecord(element, { sourceEndpoint: sourceEndpoint() });
  }

  function sendCapture(records: PostRecord[]): void {
    chrome.runtime.sendMessage({ type: 'redtap:capture', records }).catch(() => undefined);
  }

  function captureAll(root: Element | Document): void {
    const posts = root.querySelectorAll('shreddit-post');
    const records: PostRecord[] = [];
    for (const el of posts) {
      const record = extractRecord(el);
      if (record !== null) records.push(record);
    }
    if (records.length > 0) sendCapture(records);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.tagName.toLowerCase() === 'shreddit-post') {
          const record = extractRecord(el);
          if (record !== null) sendCapture([record]);
        } else {
          captureAll(el);
        }
      }
    }
  });

  function start(): void {
    captureAll(document);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
