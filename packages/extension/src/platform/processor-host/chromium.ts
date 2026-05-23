/**
 * Chromium offscreen-document engine host bootstrap.
 *
 * Chromium MV3 service workers cannot hold a Web Worker, DOM, or Blob URLs
 * across restarts. We create an offscreen document the first time an engine
 * job needs to run; the offscreen page loads the engine runner module which
 * registers its own runtime.onMessage listener.
 */

const OFFSCREEN_DOCUMENT_PATH = "src/engine/offscreen.html";

let creating: Promise<void> | null = null;

interface OffscreenContext { readonly documentUrl?: string }
type GetContextsFn = (filter: {
  contextTypes: string[];
  documentUrls?: string[];
}) => Promise<OffscreenContext[]>;

export async function ensureEngineHost(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const getContexts = (chrome.runtime as unknown as { getContexts?: GetContextsFn }).getContexts;
  if (getContexts) {
    const contexts = await getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length > 0) return;
  }

  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["BLOBS" as chrome.offscreen.Reason],
    justification: "Runs browser-side HLS download jobs and creates Blob URLs.",
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function closeEngineHost(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No active offscreen document.
  }
}
