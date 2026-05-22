import { MAIN_BRIDGE_TAG, type MainToBridgeMessage, type CaptureKind } from "../types/messages";

const post = (msg: Omit<MainToBridgeMessage, typeof MAIN_BRIDGE_TAG>): void => {
  window.postMessage({ [MAIN_BRIDGE_TAG]: true, ...msg } as MainToBridgeMessage, "*");
};

const emit = (kind: CaptureKind, url: string | null, extras: Partial<MainToBridgeMessage> = {}): void => {
  post({ kind, url, pageUrl: location.href, ...extras });
};

function looksLikeMedia(url: string): boolean {
  if (!url) return false;
  if (/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|mpegts|m4s|avi|flv|wmv)(\?|#|$)/i.test(url)) return true;
  return false;
}

const _fetch = window.fetch;
window.fetch = function (input, init) {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? null;
    if (url && looksLikeMedia(url)) emit("fetch", url);
  } catch { /* swallow — never break the page */ }
  return _fetch.apply(this, [input, init]);
};

const _xhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...rest: unknown[]) {
  try {
    const str = String(url);
    if (looksLikeMedia(str)) emit("xhr", str);
  } catch { /* */ }
  // @ts-expect-error variadic forward
  return _xhrOpen.call(this, method, url, ...rest);
};

if (typeof MediaSource !== "undefined") {
  const _isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = function (type: string) {
    if (/;\s*encrypted/i.test(type)) emit("ms-probe", null, { mimeType: type });
    return _isTypeSupported(type);
  };
}

if (navigator.requestMediaKeySystemAccess) {
  const _orig = navigator.requestMediaKeySystemAccess.bind(navigator);
  navigator.requestMediaKeySystemAccess = function (keySystem: string, config: MediaKeySystemConfiguration[]) {
    emit("eme", null, { keySystem });
    return _orig(keySystem, config);
  };
}

function observeMediaElement(el: HTMLVideoElement | HTMLAudioElement): void {
  const src = el.currentSrc || el.src || el.querySelector("source")?.src || null;
  if (src && !src.startsWith("blob:")) {
    emit("media-element", src, { elementTag: el.tagName.toLowerCase() as "video" | "audio", elementSrc: src });
  }
}

new MutationObserver(records => {
  for (const r of records) {
    r.addedNodes.forEach(n => {
      if (n instanceof HTMLVideoElement || n instanceof HTMLAudioElement) observeMediaElement(n);
      else if (n instanceof HTMLElement) {
        n.querySelectorAll("video, audio").forEach(el => observeMediaElement(el as HTMLVideoElement));
      }
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

document.querySelectorAll("video, audio").forEach(el => observeMediaElement(el as HTMLVideoElement));
