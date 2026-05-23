import type { ProtocolFamily, Container, Confidence } from "../types/stream";

export interface UrlClassification {
  readonly protocol: ProtocolFamily;
  readonly container: Container;
  readonly confidence: Confidence;
}

const EXT_TO_CONTAINER: Record<string, Container> = {
  mp4: "mp4",
  webm: "webm",
  mkv: "mkv",
  ts: "mpegts",
  m4s: "fmp4",
};

const EXT_TO_PROTOCOL: Record<string, ProtocolFamily> = {
  m3u8: "hls",
  mpd: "dash",
};

function extension(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    return path.slice(dot + 1).toLowerCase();
  } catch {
    return null;
  }
}

export function classifyByUrl(url: string): UrlClassification {
  const ext = extension(url);
  const protocol: ProtocolFamily =
    ext && EXT_TO_PROTOCOL[ext] ? EXT_TO_PROTOCOL[ext]! : "unknown";
  const container: Container =
    ext && EXT_TO_CONTAINER[ext] ? EXT_TO_CONTAINER[ext]! : "unknown";

  return {
    protocol,
    container,
    confidence: {
      protocol: "guessed",
      container: "guessed",
      codecs: "guessed",
    },
  };
}
