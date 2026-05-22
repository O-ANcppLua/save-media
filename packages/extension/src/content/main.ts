// Content scripts in MV3 are injected as classic scripts — `import` is
// a syntax error. We intentionally duplicate this constant (also defined
// in src/types/messages.ts) so this file has no module dependencies and
// can ship as a standalone JS file.
//
// The `export {}` below is a TypeScript-only marker that makes tsc treat
// this file as a module (so its top-level const doesn't clash with the
// twin declaration in bridge.ts); Vite/rollup elides it at build time
// because nothing is actually exported, leaving the output as a plain
// classic-script-compatible JS file.
export {};
const BRIDGE_TAG = "__savemedia" as const;

type CaptureKind = "fetch" | "xhr" | "media-element" | "media-source" | "eme" | "ms-probe";
interface MainToBridgeMessage {
  [BRIDGE_TAG]: true;
  kind: CaptureKind;
  url: string | null;
  pageUrl: string;
  responseHeaders?: Readonly<Record<string, string>>;
  responseBodyHeadB64?: string;
  keySystem?: string;
  mimeType?: string;
  elementTag?: "video" | "audio";
  elementSrc?: string;
}

const post = (msg: Omit<MainToBridgeMessage, typeof BRIDGE_TAG>): void => {
  window.postMessage({ [BRIDGE_TAG]: true, ...msg } as MainToBridgeMessage, "*");
};

/**
 * Canonicalise the captured URL against the page origin BEFORE posting.
 * The background service worker fetches this URL to classify it, and SW
 * fetch has no page-relative base — a bare "/hls/master.m3u8" would
 * resolve against `chrome-extension://<id>/` and 404. Resolving against
 * `location.href` here gives the SW an absolute URL that hits the
 * actual content origin.
 */
function canonicaliseUrl(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url, location.href).href; } catch { return url; }
}

const emit = (kind: CaptureKind, url: string | null, extras: Partial<MainToBridgeMessage> = {}): void => {
  post({ kind, url: canonicaliseUrl(url), pageUrl: location.href, ...extras });
};

/**
 * Match URLs that are the entry point of a stream — manifests or full
 * progressive files — NOT individual segments. CMAF/HLS-fMP4 segments
 * end in `.m4s` and DASH/HLS-TS segments end in `.ts`/`.m4s`. The
 * engine walks segments via the master/media playlist on its own; if
 * we surface them as separate descriptors the popup fills with N+1
 * "fake" items per stream and the user ends up downloading one chunk
 * instead of the whole video.
 *
 * `.ts` is intentionally excluded too (collides with TypeScript files
 * and tooling URLs; standalone MPEG-TS files almost never have this
 * extension on the open web).
 */
function looksLikeMedia(url: string): boolean {
  if (!url) return false;
  return /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|wmv)(\?|#|$)/i.test(url);
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
