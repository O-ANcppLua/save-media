import type {
  HlsPlainPlan,
  HlsAesPlan,
  StreamDescriptor,
  Variant,
} from "@savemedia/core";
import { RETRY_POLICY } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import {
  parseHlsMediaPlaylistRuntime,
  type RuntimeSegment,
  type RuntimeEncryption,
} from "../parsers/hls";
import { fetchWithRetry } from "../net/fetch-with-retry";

/**
 * Engine-side HLS job runner.
 *
 * **Encryption authority lives at runtime, not at dispatch.** The master
 * playlist (which dispatch saw) usually doesn't carry EXT-X-KEY; the key
 * lives on the media playlist. So the runner:
 *   1. fetches the media playlist
 *   2. inspects the runtime parser's `encryption` field
 *   3. AES-128 → SubtleCrypto decrypt per segment
 *   4. SAMPLE-AES / SAMPLE-AES-CTR / unknown METHOD → throw cdm_required
 *      (DO NOT ship encrypted bytes to disk)
 *   5. null / METHOD=NONE → plain concatenation
 *
 * This is independent of `plan.kind` so an hls-plain dispatch decision
 * cannot leak ciphertext when the media playlist is actually encrypted.
 */
export async function runHlsJob(
  plan: HlsPlainPlan | HlsAesPlan,
  descriptor: StreamDescriptor,
  onProgress: ProgressFn,
  signal: AbortSignal,
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
  const playlistResp = await fetchWithRetry(playlistUrl, signal, "manifest");
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

  // Runtime-authoritative encryption decision. The plan kind is advisory.
  const cryptoKey = await resolveDecryptionKey(media.encryption, signal);

  return fetchSegments(media.segments, plan, onProgress, signal, cryptoKey);
}

async function resolveDecryptionKey(
  encryption: RuntimeEncryption | null,
  signal: AbortSignal,
): Promise<CryptoKey | null> {
  if (!encryption) return null;
  const method = encryption.method.toUpperCase();
  if (method === "" || method === "NONE") return null;
  if (method === "AES-128") {
    return loadAesKey(encryption.keyUri, signal);
  }
  // SAMPLE-AES, SAMPLE-AES-CTR, AES-CTR, or anything we don't recognise.
  // Refuse — we will not write ciphertext to disk under a clear-output filename.
  throw {
    code: "cdm_required",
    severity: "terminal",
    keySystem: method,
  };
}

async function fetchSegments(
  segments: readonly RuntimeSegment[],
  plan: HlsPlainPlan | HlsAesPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  cryptoKey: CryptoKey | null,
): Promise<JobResult> {
  const failed: number[] = [];
  let consecutiveFailures = 0;
  let bytesWritten = 0;
  const parts: BlobPart[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) {
      throw new DOMException("user-cancelled", "AbortError");
    }
    const seg = segments[i]!;
    try {
      const resp = await fetchWithRetry(seg.uri, signal, "segment");
      let body: Uint8Array = new Uint8Array(await resp.arrayBuffer());
      if (cryptoKey) {
        body = await decryptAes128(body, cryptoKey, seg, i);
      }
      parts.push(body as BlobPart);
      bytesWritten += body.byteLength;
      consecutiveFailures = 0;
      onProgress(bytesWritten, null, `segment ${i + 1}/${segments.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      // Decrypt failures and cdm_required must terminate the job — they're
      // not retryable, so don't fold them into the segment-budget logic.
      if (isTerminalThrown(err)) throw err;
      failed.push(i);
      consecutiveFailures += 1;
      const overBudget = failed.length / segments.length > RETRY_POLICY.job.maxFailedSegmentRatio;
      const tooManyInARow = consecutiveFailures >= RETRY_POLICY.job.maxConsecutiveFailures;
      if (overBudget || tooManyInARow) {
        throw {
          code: "segment_budget_exhausted",
          severity: "terminal",
          failedSegments: failed,
          totalSegments: segments.length,
        };
      }
    }
  }

  if (signal.aborted) {
    throw new DOMException("user-cancelled", "AbortError");
  }

  onProgress(bytesWritten, bytesWritten, "muxing");
  const { mime, filename } = honestOutput(parts, plan, segments);
  const blob = new Blob(parts, { type: mime });
  onProgress(bytesWritten, bytesWritten, "finalizing");
  return {
    blobUrl: URL.createObjectURL(blob),
    filename,
    checksum: "",
  };
}

function isTerminalThrown(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = (err as { code: string }).code;
  return code === "cdm_required"
    || code === "encrypted_media_detected"
    || code === "clear_segments_unavailable"
    || code === "license_bound_stream"
    || code === "clearkey_deferred";
}

async function loadAesKey(keyUri: string, signal: AbortSignal): Promise<CryptoKey> {
  const resp = await fetchWithRetry(keyUri, signal, "manifest");
  const raw = await resp.arrayBuffer();
  if (raw.byteLength !== 16) {
    throw {
      code: "license_bound_stream",
      severity: "terminal",
      keyUri,
      httpStatus: resp.status,
    };
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC", length: 128 }, false, ["decrypt"]);
}

async function decryptAes128(
  ciphertext: Uint8Array,
  key: CryptoKey,
  segment: RuntimeSegment,
  index: number,
): Promise<Uint8Array> {
  const iv = segment.iv ?? mediaSequenceIv(segment.mediaSequence ?? index);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  // Copy into a fresh ArrayBuffer-backed Uint8Array so callers can pass it
  // through Blob() without TS objecting about ArrayBufferLike vs ArrayBuffer.
  const out = new Uint8Array(plain.byteLength);
  out.set(new Uint8Array(plain));
  return out;
}

function mediaSequenceIv(sequenceNumber: number): Uint8Array {
  // HLS spec § 4.3.2.4: if IV is absent, the sequence number is the IV,
  // big-endian, padded to 16 bytes.
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequenceNumber, false);
  return iv;
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
 * Sniff the first segment to decide the real on-disk container, then
 * rename the output filename to match. The plan's outputContainer is the
 * requested target — when our concatenation-only path can't satisfy it
 * (e.g. MPEG-TS bytes were requested as MP4) we honestly emit `.ts` so
 * the user doesn't get a misnamed file. Real MP4 remux of MPEG-TS needs
 * the ffmpeg.wasm transcode path.
 */
function honestOutput(
  parts: readonly BlobPart[],
  plan: HlsPlainPlan | HlsAesPlan,
  segments: readonly RuntimeSegment[],
): { mime: string; filename: string } {
  const sniff = sniffContainer(parts[0], segments[0]?.uri);
  const requested = plan.outputContainer;
  // fMP4/CMAF concatenation produces a valid MP4 → honour the request.
  if (sniff === "fmp4" && requested === "mp4") return { mime: "video/mp4", filename: plan.outputFilename };
  if (sniff === "webm" && requested === "webm") return { mime: "video/webm", filename: plan.outputFilename };
  // MPEG-TS concatenation is NOT a valid MP4. Force .ts so the file plays.
  if (sniff === "mpegts") {
    return { mime: "video/mp2t", filename: replaceExt(plan.outputFilename, "ts") };
  }
  // Unknown sniff: trust the request but flag with a generic mime.
  return { mime: mimeForContainer(requested), filename: plan.outputFilename };
}

type ContainerSniff = "fmp4" | "mpegts" | "webm" | "unknown";

function sniffContainer(part: BlobPart | undefined, segmentUri: string | undefined): ContainerSniff {
  const bytes = partToHead(part);
  if (bytes && bytes.length > 0) {
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "fmp4"; // ftyp
    if (bytes.length >= 8 && bytes[4] === 0x6D && bytes[5] === 0x6F && bytes[6] === 0x6F && bytes[7] === 0x66) return "fmp4"; // moof
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

function partToHead(part: BlobPart | undefined): Uint8Array | null {
  if (!part) return null;
  if (part instanceof Uint8Array) return part.subarray(0, 32);
  if (part instanceof ArrayBuffer) return new Uint8Array(part).subarray(0, 32);
  return null;
}

function replaceExt(filename: string, ext: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return `${filename}.${ext}`;
  return `${filename.slice(0, idx)}.${ext}`;
}

function mimeForContainer(c: string): string {
  switch (c) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mkv": return "video/x-matroska";
    default: return "application/octet-stream";
  }
}
