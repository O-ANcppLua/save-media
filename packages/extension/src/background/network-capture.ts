import { MAIN_BRIDGE_TAG, type BridgeToBackgroundMessage, type CaptureKind } from "../types/messages";

export type CaptureHandler = (
  tabId: number,
  msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>,
) => Promise<void>;

interface RequestDetails {
  readonly tabId: number;
  readonly url: string;
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

export function looksLikeMediaEntryUrl(url: string): boolean {
  return /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|wmv)(\?|#|$)/i.test(url);
}

async function handleNetworkRequest(
  details: RequestDetails,
  handleCapture: CaptureHandler,
): Promise<void> {
  if (details.tabId < 0 || !looksLikeMediaEntryUrl(details.url)) return;

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
