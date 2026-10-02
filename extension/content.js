// redtap content script: passively captures shreddit-post elements as the
// user browses Reddit and hands normalized records to the service worker.
(() => {
  'use strict';

  const seen = new Set();

  function sourceEndpoint() {
    try { return new URL(location.href).pathname; } catch { return '/'; }
  }

  function extractRecord(element) {
    if (!element || element.tagName?.toLowerCase() !== 'shreddit-post') return null;
    const attr = (name) => element.getAttribute?.(name) ?? null;
    const id = attr('id');
    const permalink = attr('permalink');
    if (!id || !permalink) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    const exact = (v) => {
      if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) return Number(v);
      return null;
    };
    const ratioRaw = attr('upvote-ratio');
    const bodyText = (element.querySelector?.('[slot="text-body"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20_000);
    const record = {
      post_id: id,
      post_at: attr('created-timestamp'),
      captured_at: Date.now(),
      source_endpoint: sourceEndpoint(),
      contributed_by: 'local',
      pooled_at: null,
      title: attr('post-title'),
      author: attr('author'),
      author_id: attr('author-id'),
      subreddit: attr('subreddit-prefixed-name'),
      subreddit_id: attr('subreddit-id'),
      permalink,
      post_type: attr('post-type'),
      domain: attr('domain'),
      content_href: attr('content-href'),
      view_context: attr('view-context'),
      award_count: exact(attr('award-count')),
      metrics: { score: exact(attr('score')), comments: exact(attr('comment-count')), upvote_ratio: ratioRaw === null ? null : Number(ratioRaw) },
    };
    if (bodyText.length > 0) record.selftext = bodyText;
    return record;
  }

  function captureAll(root) {
    const posts = (root ?? document).querySelectorAll('shreddit-post');
    const records = [];
    for (const el of posts) {
      const record = extractRecord(el);
      if (record) records.push(record);
    }
    if (records.length > 0) {
      try { chrome.runtime.sendMessage({ type: 'redtap:capture', records }).catch(() => {}); } catch {}
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName?.toLowerCase() === 'shreddit-post') {
          const record = extractRecord(node);
          if (record) {
            try { chrome.runtime.sendMessage({ type: 'redtap:capture', records: [record] }).catch(() => {}); } catch {}
          }
        } else if (node.querySelectorAll) {
          captureAll(node);
        }
      }
    }
  });

  function start() {
    captureAll(document);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
