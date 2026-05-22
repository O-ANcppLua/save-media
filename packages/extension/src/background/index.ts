import {
  classify,
  type StreamDescriptor,
} from "@savemedia/core";
import type {
  BridgeToBackgroundMessage,
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
} from "../types/messages";

interface TabState {
  readonly descriptors: Map<string, StreamDescriptor>;
}

const tabs = new Map<number, TabState>();

function getTab(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    state = { descriptors: new Map() };
    tabs.set(tabId, state);
  }
  return state;
}

chrome.tabs.onRemoved.addListener(tabId => tabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) tabs.delete(tabId);
});

async function handleCapture(tabId: number, msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>): Promise<void> {
  const cap = msg.payload;
  if (!cap.url && cap.kind !== "eme") return;

  let headers: Record<string, string> = cap.responseHeaders ?? {};
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
    } catch {
      // CORS / network — proceed with what we have
    }
  }

  if (cap.kind === "eme" && cap.keySystem) {
    headers = { ...headers, "x-savemedia-eme-keysystem": cap.keySystem };
  }

  const descriptor = await classify({
    tabId,
    pageUrl: cap.pageUrl,
    url: cap.url ?? cap.pageUrl,
    headers,
    bodyBytes,
    manifestText,
  });

  const key = `${descriptor.source.kind}:${descriptor.protocol}:${cap.url ?? cap.pageUrl}`;
  const state = getTab(tabId);
  if (!state.descriptors.has(key)) {
    state.descriptors.set(key, descriptor);
    updateBadge(tabId);
  }
}

function updateBadge(tabId: number): void {
  const count = getTab(tabId).descriptors.size;
  const text = count > 0 ? String(count) : "";
  void chrome.action.setBadgeText({ tabId, text });
  if (count > 0) void chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
}

chrome.runtime.onMessage.addListener((msg: BridgeToBackgroundMessage | PopupToBackgroundMessage, sender, sendResponse) => {
  if ("type" in msg && msg.type === "capture") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void handleCapture(tabId, msg);
    return false;
  }

  if (msg.type === "list") {
    const state = tabs.get(msg.tabId);
    const descriptors = state ? Array.from(state.descriptors.values()) : [];
    const response: BackgroundToPopupMessage = { type: "descriptors", tabId: msg.tabId, descriptors };
    sendResponse(response);
    return false;
  }

  if (msg.type === "download") {
    // Engine wiring (Plan 3) attaches here.
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "cancel") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "ready") {
    return false;
  }

  return false;
});
