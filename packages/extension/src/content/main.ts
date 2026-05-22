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

type CaptureKind = "media-element" | "media-source" | "eme" | "ms-probe";
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
 * Resource timing gives us a passive page-side fallback for very early
 * manifest requests without monkey-patching fetch/XHR. The background
 * webRequest listener is the main discovery path; this catches entries
 * that raced ahead during extension startup.
 */
function looksLikeMediaEntry(url: string): boolean {
  return /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|wmv)(\?|#|$)/i.test(url);
}

function observeResourceUrl(url: string): void {
  if (looksLikeMediaEntry(url)) emit("media-source", url);
}

try {
  performance.getEntriesByType("resource").forEach(entry => observeResourceUrl(entry.name));
  const observer = new PerformanceObserver(list => {
    list.getEntries().forEach(entry => observeResourceUrl(entry.name));
  });
  observer.observe({ type: "resource", buffered: true });
} catch {
  // Resource timing is best-effort; never perturb the page.
}

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
