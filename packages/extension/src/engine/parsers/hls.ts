import { Parser } from "m3u8-parser";

/**
 * Runtime media-playlist parser used by the engine after the master is
 * resolved to a variant. The core `@savemedia/core` parser produces typed
 * StreamDescriptors; this lighter helper is just the URL list + per-segment
 * IV/sequence the engine needs to fetch and decrypt.
 *
 * **The runtime parser is the authoritative source for HLS encryption**:
 * the master playlist almost never carries EXT-X-KEY (it lives on the
 * media playlist), so the engine must call this and trust its `encryption`
 * field rather than the one on the variant's segmentRef.
 */

export interface RuntimeEncryption {
  /** Uppercased EXT-X-KEY METHOD: AES-128, SAMPLE-AES, SAMPLE-AES-CTR, … */
  readonly method: string;
  readonly keyUri: string;
  /** IV declared in EXT-X-KEY, if any. Otherwise derived from media sequence. */
  readonly iv: Uint8Array | null;
}

export interface RuntimeSegment {
  readonly uri: string;
  readonly duration: number;
  readonly iv: Uint8Array | null;
  readonly mediaSequence: number | null;
}

export interface RuntimePlaylist {
  readonly initSegmentUrl: string | null;
  readonly segments: readonly RuntimeSegment[];
  readonly targetDuration: number | null;
  readonly isVod: boolean;
  readonly encryption: RuntimeEncryption | null;
}

export function parseHlsMediaPlaylistRuntime(text: string, playlistUrl: string): RuntimePlaylist {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest;
  const startSeq = (m.mediaSequence ?? 0) as number;
  const firstMap = m.segments?.find(s => s.map?.uri)?.map ?? null;
  const segs: RuntimeSegment[] = (m.segments ?? []).map((s, i) => ({
    uri: new URL(s.uri, playlistUrl).href,
    duration: s.duration,
    iv: s.key?.iv ? copyToUint8(s.key.iv) : null,
    mediaSequence: startSeq + i,
  }));

  const firstKey = (m.segments ?? []).find(s => s.key)?.key ?? null;
  const encryption: RuntimeEncryption | null = firstKey
    ? {
        method: String(firstKey.method ?? "").toUpperCase(),
        keyUri: new URL(firstKey.uri, playlistUrl).href,
        iv: firstKey.iv ? copyToUint8(firstKey.iv) : null,
      }
    : null;

  return {
    initSegmentUrl: firstMap?.uri ? new URL(firstMap.uri, playlistUrl).href : null,
    segments: segs,
    targetDuration: typeof m.targetDuration === "number" ? m.targetDuration : null,
    isVod: m.endList === true,
    encryption,
  };
}

function copyToUint8(view: ArrayBufferView): Uint8Array {
  const dst = new Uint8Array(view.byteLength);
  dst.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return dst;
}
