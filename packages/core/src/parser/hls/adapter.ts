import { Parser } from "m3u8-parser";
import type { Variant, VariantId } from "../../types/codec";
import { parseVideoCodec, parseAudioCodec } from "../../classifier/codec-registry";

export interface HlsMasterParseResult {
  readonly variants: readonly Variant[];
  readonly encryption: null;
}

export interface HlsMediaPlaylistParseResult {
  readonly segments: ReadonlyArray<{ readonly uri: string; readonly duration: number }>;
  readonly initSegmentUrl: string | null;
  readonly encryption: {
    readonly method: string;
    readonly uri: string;
    readonly iv: Uint8Array | null;
  } | null;
}

function splitCodecs(codecs: string): [string | null, string | null] {
  if (!codecs) return [null, null];
  const parts = codecs.split(",").map(s => s.trim());
  const isVideo = (s: string) => /^(avc|hvc|hev|vp08|vp09|av01|mp4v)/i.test(s);
  const isAudio = (s: string) => /^(mp4a|opus|ac-3|ec-3|alac|vorbis|flac|mp3)/i.test(s);
  const v = parts.find(isVideo) ?? null;
  const a = parts.find(isAudio) ?? null;
  return [v, a];
}

export function parseHlsMaster(manifestText: string, manifestUrl: string): HlsMasterParseResult {
  const parser = new Parser();
  parser.push(manifestText);
  parser.end();

  const manifest = parser.manifest;
  const variants: Variant[] = [];

  for (let i = 0; i < (manifest.playlists ?? []).length; i++) {
    const p = (manifest.playlists ?? [])[i];
    if (!p) continue;
    const codecsAttr: string = p.attributes?.CODECS ?? "";
    const [vCodecStr, aCodecStr] = splitCodecs(codecsAttr);

    variants.push({
      id: `${manifestUrl}#var${i}` as VariantId,
      width: p.attributes?.RESOLUTION?.width ?? null,
      height: p.attributes?.RESOLUTION?.height ?? null,
      frameRate: p.attributes?.["FRAME-RATE"] ?? null,
      bitrate: p.attributes?.BANDWIDTH ?? null,
      estimatedSize: null,
      videoCodec: vCodecStr ? parseVideoCodec(vCodecStr) : null,
      audioCodec: aCodecStr ? parseAudioCodec(aCodecStr) : null,
      audioRenditionId: null,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: new URL(p.uri, manifestUrl).href,
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      },
    });
  }

  return { variants, encryption: null };
}

export function parseHlsMediaPlaylist(manifestText: string, manifestUrl: string): HlsMediaPlaylistParseResult {
  const parser = new Parser();
  parser.push(manifestText);
  parser.end();

  const manifest = parser.manifest;
  const segs = manifest.segments ?? [];
  const firstMap = segs.find(s => s.map?.uri)?.map ?? null;

  // AES-128 key is attached per-segment
  const segKey = segs.find(s => s.key)?.key;

  // SAMPLE-AES (FairPlay, Widevine) lands in contentProtection instead
  const cpEntries = manifest.contentProtection
    ? Object.values(manifest.contentProtection)
    : [];
  const cpEntry = cpEntries[0];
  const contentProtectionKey =
    cpEntry && cpEntry.attributes.METHOD !== "NONE"
      ? { method: cpEntry.attributes.METHOD, uri: cpEntry.attributes.URI, iv: null as Uint8Array | null }
      : null;

  const rawKey = segKey
    ? { method: segKey.method, uri: segKey.uri, iv: segKey.iv ?? null }
    : contentProtectionKey;

  return {
    initSegmentUrl: firstMap?.uri ? new URL(firstMap.uri, manifestUrl).href : null,
    segments: segs.map(s => ({ uri: new URL(s.uri, manifestUrl).href, duration: s.duration })),
    encryption: rawKey
      ? { method: rawKey.method, uri: new URL(rawKey.uri, manifestUrl).href, iv: rawKey.iv }
      : null,
  };
}
