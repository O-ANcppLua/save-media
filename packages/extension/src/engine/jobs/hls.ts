import type {
  HlsPlainPlan,
  StreamDescriptor,
  Variant,
} from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import {
  parseHlsMediaPlaylistRuntime,
  type RuntimeSegment,
  type RuntimeEncryption,
} from "../parsers/hls";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyNetworkFailure } from "../net/error-classification";
import { InMemorySink, type JobSink } from "../sink";
import { remuxTsToMp4 } from "../remux/ts-to-mp4";

/**
 * Engine-side HLS job runner.
 *
 * **Encryption authority lives at runtime, not at dispatch.** The master
 * playlist (which dispatch saw) usually doesn't carry EXT-X-KEY; the key
 * lives on the media playlist. So the runner:
 *   1. fetches the media playlist
 *   2. requires a fixed VOD playlist (`EXT-X-ENDLIST`)
 *   3. refuses any `EXT-X-KEY` method
 *   4. remuxes MPEG-TS segments to MP4 through mediabunny
 *
 * This is independent of `plan.kind` so an hls-plain dispatch decision
 * cannot leak ciphertext when the media playlist is actually encrypted.
 */
export async function runHlsJob(
  plan: HlsPlainPlan,
  descriptor: StreamDescriptor,
  onProgress: ProgressFn,
  signal: AbortSignal,
  externalSink?: JobSink,
): Promise<JobResult> {
  const variant = findVariant(descriptor, plan.variantId);
  if (!variant) {
    throw {
      code: "no_variant_meets_minimum",
      severity: "terminal",
      minHeightRequired: 720,
      maxAvailableHeight: 0,
    };
  }

  const playlistUrl = playlistUrlOf(variant);
  if (!playlistUrl) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.pageUrl,
      parserError: "variant missing media playlist URL",
    };
  }

  onProgress(0, null, "fetching-playlist");
  const playlistResp = await fetchWithRetry(playlistUrl, signal, "manifest").catch(err => {
    throw classifyNetworkFailure(err, "manifest", playlistUrl) ?? err;
  });
  const playlistText = await playlistResp.text();
  const media = parseHlsMediaPlaylistRuntime(playlistText, playlistUrl);

  if (media.segments.length === 0) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: playlistUrl,
      parserError: "media playlist has zero segments",
    };
  }

  assertSupportedPlainVod(media, playlistUrl);

  return fetchSegments(media, plan, onProgress, signal, externalSink);
}

function assertSupportedPlainVod(
  media: { readonly isVod: boolean; readonly encryption: RuntimeEncryption | null; readonly initSegmentUrl: string | null },
  playlistUrl: string,
): void {
  if (!media.isVod) {
    throw {
      code: "hls_live_unsupported",
      severity: "terminal",
      manifestUrl: playlistUrl,
    };
  }
  if (media.encryption) {
    const method = media.encryption.method.toUpperCase();
    if (method === "AES-128") {
      throw {
        code: "hls_encryption_unsupported",
        severity: "terminal",
        manifestUrl: playlistUrl,
        method,
      };
    }
    throw {
      code: "cdm_required",
      severity: "terminal",
      keySystem: method,
    };
  }
  if (media.initSegmentUrl) {
    throw {
      code: "hls_layout_unsupported",
      severity: "terminal",
      manifestUrl: playlistUrl,
      detail: "HLS fMP4/CMAF playlists require structural MP4 validation that is not enabled.",
    };
  }
}

function unsupportedLayout(manifestUrl: string, detail: string): never {
  throw {
    code: "hls_layout_unsupported",
    severity: "terminal",
    manifestUrl,
    detail,
  };
}

async function fetchSegments(
  media: { readonly initSegmentUrl: string | null; readonly segments: readonly RuntimeSegment[] },
  plan: HlsPlainPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  externalSink: JobSink | undefined,
): Promise<JobResult> {
  const { initSegmentUrl, segments } = media;
  const failed: number[] = [];
  let bytesWritten = 0;
  // Sniff the first segment before opening the sink. Unknown bytes are refused
  // instead of guessed from a URL extension.
  let firstBytes: Uint8Array | null = null;
  let sink: JobSink | null = externalSink ?? null;
  let openedFilename: string | null = null;
  const writtenParts: Uint8Array[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) {
      if (sink) await sink.abort();
      throw new DOMException("user-cancelled", "AbortError");
    }
    const seg = segments[i]!;
    try {
      const resp = await fetchWithRetry(seg.uri, signal, "segment");
      let body: Uint8Array = new Uint8Array(await resp.arrayBuffer());
      if (firstBytes === null) {
        firstBytes = body;
        const { mime, filename } = honestOutput(body, seg.uri, plan, false);
        if (!sink) sink = new InMemorySink(mime);
        await sink.open(filename, plan.estimatedBytes);
        openedFilename = filename;
      }
      await sink!.write(body);
      writtenParts.push(body);
      bytesWritten += body.byteLength;
      onProgress(bytesWritten, null, `segment ${i + 1}/${segments.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      if (isTerminalThrown(err)) {
        if (sink && openedFilename) await sink.abort();
        throw err;
      }
      failed.push(i);
      if (sink && openedFilename) await sink.abort();
      throw classifyNetworkFailure(err, "segment", seg.uri) ?? {
        code: "segment_budget_exhausted",
        severity: "terminal",
        failedSegments: failed,
        totalSegments: segments.length,
      };
    }
  }

  if (signal.aborted) {
    if (sink && openedFilename) await sink.abort();
    throw new DOMException("user-cancelled", "AbortError");
  }

  if (!sink || openedFilename === null || firstBytes === null) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: "",
      parserError: "no segments produced bytes",
    };
  }

  // MPEG-TS source + caller wants MP4 → run a real container remux.
  // Concatenating .ts bytes and calling them .mp4 is a lie that breaks
  // QuickTime / iOS. mediabunny copies the H.264/AAC packets into an
  // MP4 box structure (no re-encode) and we ship that instead.
  const sniff = sniffContainer(firstBytes, initSegmentUrl ?? segments[0]?.uri);
  if (sniff === "mpegts" && plan.outputContainer === "mp4") {
    onProgress(bytesWritten, bytesWritten, "remuxing-ts-to-mp4");
    const tsBytes = concatUint8Arrays(writtenParts);
    await sink.abort();
    const mp4Bytes = await remuxTsToMp4(tsBytes, (fraction) => {
      onProgress(bytesWritten, bytesWritten, `remuxing ${Math.round(fraction * 100)}%`);
    });
    assertMp4Bytes(mp4Bytes);
    const mp4Blob = new Blob([mp4Bytes as BlobPart], { type: "video/mp4" });
    onProgress(bytesWritten, bytesWritten, "finalizing");
    return {
      blobUrl: URL.createObjectURL(mp4Blob),
      filename: replaceExt(openedFilename, "mp4"),
      checksum: "",
    };
  }

  onProgress(bytesWritten, bytesWritten, "muxing");
  const result = await sink.close();
  onProgress(bytesWritten, bytesWritten, "finalizing");
  return result;
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const u of parts) {
    out.set(u, off);
    off += u.byteLength;
  }
  return out;
}

function assertMp4Bytes(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    throw {
      code: "verification_container",
      severity: "terminal",
      probeError: "TS remux did not produce an MP4 ftyp box",
    };
  }
}

function isTerminalThrown(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = (err as { code: string }).code;
  return code === "cdm_required"
    || code === "manifest_malformed"
    || code === "encrypted_media_detected"
    || code === "clear_segments_unavailable"
    || code === "license_bound_stream"
    || code === "clearkey_deferred"
    || code === "hls_encryption_unsupported"
    || code === "hls_live_unsupported"
    || code === "hls_layout_unsupported";
}

function findVariant(d: StreamDescriptor, variantId: string): Variant | null {
  for (const v of d.variants) if (v.id === variantId) return v;
  return d.variants[0] ?? null;
}

function playlistUrlOf(v: Variant): string | null {
  if (v.segmentRef.kind === "hls-segments") return v.segmentRef.playlistUrl;
  return null;
}

/**
 * Sniff the first bytes to decide the real on-disk container, then
 * rename the output filename to match. The plan's outputContainer is the
 * requested target — when our concatenation-only path can't satisfy it
 * we either take a real remux path (MPEG-TS → MP4) or fail before a
 * misleading file reaches disk.
 */
function honestOutput(
  firstSegment: Uint8Array,
  firstSegmentUri: string | undefined,
  plan: HlsPlainPlan,
  _hasInitSegment: boolean,
): { mime: string; filename: string } {
  const sniff = sniffContainer(firstSegment, firstSegmentUri);
  if (sniff === "mpegts") {
    return { mime: "video/mp2t", filename: replaceExt(plan.outputFilename, "ts") };
  }
  return unsupportedLayout(
    firstSegmentUri ?? "",
    `The first HLS segment did not look like MPEG-TS (${sniff}).`,
  );
}

type ContainerSniff = "fmp4" | "fmp4-fragment" | "mpegts" | "webm" | "unknown";

function sniffContainer(bytes: Uint8Array | undefined, segmentUri: string | undefined): ContainerSniff {
  if (bytes && bytes.length > 0) {
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "fmp4"; // ftyp
    if (bytes.length >= 8 && bytes[4] === 0x6D && bytes[5] === 0x6F && bytes[6] === 0x6F && bytes[7] === 0x66) return "fmp4-fragment"; // moof
    if (bytes[0] === 0x47) return "mpegts"; // TS sync byte
    if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return "webm"; // EBML
    // Bytes were present but didn't match a known magic — trust the
    // request rather than guessing from the URL extension (which may lie).
    return "unknown";
  }
  if (segmentUri) {
    if (/\.(ts|mpegts)(\?|#|$)/i.test(segmentUri)) return "mpegts";
    if (/\.(m4s|mp4|m4v)(\?|#|$)/i.test(segmentUri)) return "fmp4";
  }
  return "unknown";
}

function replaceExt(filename: string, ext: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return `${filename}.${ext}`;
  return `${filename.slice(0, idx)}.${ext}`;
}
