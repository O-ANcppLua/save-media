import { classify } from "@savemedia/core";
import type {
  BridgeToBackgroundMessage,
  PopupToBackgroundMessage,
  EngineToBackgroundMessage,
} from "../types/messages";
import { createRouter } from "./router";
import { ensureEngineHost } from "../platform/processor-host";
import { consoleLogger } from "../util/logger";

declare const __BROWSER__: "chromium" | "firefox";

const logger = consoleLogger("bg");

const router = createRouter({
  runtime: {
    sendMessage: (msg, cb) => {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
        cb?.(undefined);
      });
    },
  },
  downloads: {
    download: async (opts) => chrome.downloads.download(opts as chrome.downloads.DownloadOptions),
  },
  ensureEngineHost,
  logger,
});

chrome.tabs.onRemoved.addListener(tabId => router.clearTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) router.clearTab(tabId);
});

async function handleCapture(
  tabId: number,
  msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>,
): Promise<void> {
  const cap = msg.payload;
  if (!cap.url && cap.kind !== "eme") return;

  const headers: Record<string, string> = cap.responseHeaders ? { ...cap.responseHeaders } : {};
  let bodyBytes: Uint8Array | null = null;
  let manifestText: string | null = null;

  if (cap.url) {
    try {
      const r = await fetch(cap.url, { credentials: "include" });
      r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const ct = headers["content-type"] ?? "";
      if (/(mpegurl|dash\+xml|xml|text)/i.test(ct) || /\.(m3u8|mpd)(\?|$)/i.test(cap.url)) {
        manifestText = await r.text();
      } else {
        const buf = await r.clone().arrayBuffer();
        bodyBytes = new Uint8Array(buf.slice(0, 4096));
      }
    } catch (err) {
      logger.debug("capture fetch failed", { url: cap.url, err: String(err) });
    }
  }

  if (cap.kind === "eme" && cap.keySystem) {
    headers["x-savemedia-eme-keysystem"] = cap.keySystem;
  }

  const descriptor = await classify({
    tabId,
    pageUrl: cap.pageUrl,
    url: cap.url ?? cap.pageUrl,
    headers,
    bodyBytes,
    manifestText,
  });

  const added = router.addDescriptor(tabId, descriptor);
  if (added) updateBadge(tabId);
}

function updateBadge(tabId: number): void {
  const count = router.listDescriptors(tabId).length;
  const text = count > 0 ? String(count) : "";
  void chrome.action.setBadgeText({ tabId, text });
  if (count > 0) void chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
}

chrome.runtime.onMessage.addListener((
  msg: BridgeToBackgroundMessage | PopupToBackgroundMessage | EngineToBackgroundMessage,
  sender,
  sendResponse,
) => {
  if ("type" in msg && msg.type === "capture") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void handleCapture(tabId, msg);
    return false;
  }

  if (msg.type === "ready") return false;

  if (msg.type === "list" || msg.type === "download" || msg.type === "cancel") {
    void router.handlePopupMessage(msg).then(response => {
      if (response) sendResponse(response);
    });
    return true; // keep channel open
  }

  if (msg.type === "progress" || msg.type === "complete" || msg.type === "failed") {
    void router.handleEngineMessage(msg).then(forward => {
      if (forward) {
        chrome.runtime.sendMessage(forward, () => void chrome.runtime.lastError);
      }
    });
    return false;
  }

  return false;
});

// On Firefox, the engine runs in the background event page; on Chromium the
// offscreen document loads engine/host.ts via offscreen.html. The dynamic
// import collapses at build time because `__BROWSER__` is a literal define.
if (__BROWSER__ === "firefox") {
  void import("../engine/host");
}
