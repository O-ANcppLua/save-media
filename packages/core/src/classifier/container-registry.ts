import type { Container } from "../types/stream";

const FTYP_BRAND_MAP: Record<string, Container> = {
  "isom": "mp4", "iso2": "mp4", "mp41": "mp4", "mp42": "mp4", "avc1": "mp4",
  "M4V ": "mp4",
  "qt  ": "unknown",
  "msdh": "fmp4", "msix": "fmp4", "dash": "fmp4", "cmfc": "cmaf", "cmf2": "cmaf",
};

export function detectContainerFromBytes(bytes: Uint8Array): Container {
  if (bytes.length < 4) return "unknown";

  // ISO BMFF: bytes 4..8 = "ftyp"
  if (bytes.length >= 12
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    return FTYP_BRAND_MAP[brand] ?? "mp4";
  }

  // EBML (Matroska / WebM): 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const ascii = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 4096)));
    return ascii.includes("webm") ? "webm" : "mkv";
  }

  // MPEG-TS: 0x47 sync byte every 188 bytes
  if (bytes[0] === 0x47 && bytes.length > 188 && bytes[188] === 0x47) {
    return "mpegts";
  }

  return "unknown";
}

const MIME_MAP: Record<string, Container> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/mp2t": "mpegts",
};

export function detectContainerFromMime(mime: string): Container {
  if (!mime) return "unknown";
  const cleaned = mime.split(";")[0]!.trim().toLowerCase();
  return MIME_MAP[cleaned] ?? "unknown";
}
