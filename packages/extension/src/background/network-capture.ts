import { MAIN_BRIDGE_TAG, type BridgeToBackgroundMessage, type CaptureKind } from "../types/messages";

export type CaptureHandler = (
  tabId: number,
  msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>,
) => Promise<void>;

interface RequestDetails {
  readonly tabId: number;
  readonly url: string;
  readonly type?: string | undefined;
  readonly documentUrl?: string | undefined;
  readonly initiator?: string | undefined;
}

/**
 * Network request discovery lives in the extension process instead of
 * monkey-patching page fetch/XHR. That keeps page failures attributed to
 * the page and still catches manifest/direct-media entry requests.
 */
export function registerNetworkCapture(handleCapture: CaptureHandler): void {
  if (!chrome.webRequest?.onBeforeRequest) return;

  chrome.webRequest.onBeforeRequest.addListener(
    details => {
      void handleNetworkRequest(details, handleCapture);
    },
    { urls: ["<all_urls>"] },
  );
}

export function looksLikeMediaEntryUrl(url: string, requestType?: string): boolean {
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return true;
  if (looksLikeFragmentUrl(url)) return false;
  if (requestType === "xmlhttprequest") return false;
  return /\.(mp4|m4v|webm|mkv|mov|avi|flv|wmv)(\?|#|$)/i.test(url);
}

export function looksLikeFragmentUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const base = path.split("/").filter(Boolean).at(-1) ?? path;
  if (/\.(m4s|ts|mpegts)$/i.test(base)) return true;
  if (/\.mp4\/[^/]+\.(mp4|m4s)$/i.test(path)) return true;
  return /^(init|seg|segment|chunk|frag|fragment|part)[._-][a-z0-9._-]*\.(mp4|m4v)$/i.test(base);
}

async function handleNetworkRequest(
  details: RequestDetails,
  handleCapture: CaptureHandler,
): Promise<void> {
  if (details.tabId < 0 || !looksLikeMediaEntryUrl(details.url, details.type)) return;

  const pageUrl = await pageUrlFor(details);
  const kind: CaptureKind = details.url.includes(".mpd") ? "xhr" : "fetch";

  await handleCapture(details.tabId, {
    type: "capture",
    payload: {
      [MAIN_BRIDGE_TAG]: true,
      kind,
      url: details.url,
      pageUrl,
    },
  });
}

async function pageUrlFor(details: RequestDetails): Promise<string> {
  if (details.documentUrl) return details.documentUrl;
  if (details.initiator && /^https?:\/\//i.test(details.initiator)) return details.initiator;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (tab.url) return tab.url;
  } catch {
    // Tab may have gone away between the request and our async lookup.
  }
  return details.url;
}
