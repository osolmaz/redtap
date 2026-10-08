chrome.storage.local.get('steps').then((b) => chrome.storage.local.set({ steps: [...(b.steps ?? []), 'static-imports-done@' + new Date().toISOString().slice(11, 19)] }));
export { uploadFile } from './vendor/index.mjs';
