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
import { InMemorySink, type JobSink } from "../sink";
import { remuxTsToMp4 } from "../remux/ts-to-mp4";

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

  return fetchSegments(media, plan, onProgress, signal, cryptoKey, externalSink);
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
  media: { readonly initSegmentUrl: string | null; readonly segments: readonly RuntimeSegment[] },
  plan: HlsPlainPlan | HlsAesPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  cryptoKey: CryptoKey | null,
  externalSink: JobSink | undefined,
): Promise<JobResult> {
  const { initSegmentUrl, segments } = media;
  const failed: number[] = [];
  let consecutiveFailures = 0;
  let bytesWritten = 0;
  // Sniff the first segment to pick the honest mime/filename; until we
  // see the first decrypted segment we can't open the in-memory sink
  // either (the mime depends on the sniff).
  let firstBytes: Uint8Array | null = null;
  let sink: JobSink | null = externalSink ?? null;
  let openedFilename: string | null = null;

  if (initSegmentUrl) {
    onProgress(0, null, "fetching-init");
    const initResp = await fetchWithRetry(initSegmentUrl, signal, "segment");
    firstBytes = new Uint8Array(await initResp.arrayBuffer());
    const { mime, filename } = honestOutput(firstBytes, initSegmentUrl, plan, true);
    if (!sink) sink = new InMemorySink(mime);
    await sink.open(filename, plan.estimatedBytes);
    openedFilename = filename;
    await sink.write(firstBytes);
    bytesWritten += firstBytes.byteLength;
  }

  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) {
      if (sink) await sink.abort();
      throw new DOMException("user-cancelled", "AbortError");
    }
    const seg = segments[i]!;
    try {
      const resp = await fetchWithRetry(seg.uri, signal, "segment");
      let body: Uint8Array = new Uint8Array(await resp.arrayBuffer());
      if (cryptoKey) {
        body = await decryptAes128(body, cryptoKey, seg, i);
      }
      if (firstBytes === null) {
        firstBytes = body;
        const { mime, filename } = honestOutput(body, seg.uri, plan, false);
        if (!sink) sink = new InMemorySink(mime);
        await sink.open(filename, plan.estimatedBytes);
        openedFilename = filename;
      }
      await sink!.write(body);
      bytesWritten += body.byteLength;
      consecutiveFailures = 0;
      onProgress(bytesWritten, null, `segment ${i + 1}/${segments.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      if (isTerminalThrown(err)) {
        if (sink && openedFilename) await sink.abort();
        throw err;
      }
      failed.push(i);
      consecutiveFailures += 1;
      const overBudget = failed.length / segments.length > RETRY_POLICY.job.maxFailedSegmentRatio;
      const tooManyInARow = consecutiveFailures >= RETRY_POLICY.job.maxConsecutiveFailures;
      if (overBudget || tooManyInARow) {
        if (sink && openedFilename) await sink.abort();
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
    const tsBytes = concatBlobParts((sink as InMemorySink).partsForProbe());
    await sink.abort();
    const mp4Bytes = await remuxTsToMp4(tsBytes, (fraction) => {
      onProgress(bytesWritten, bytesWritten, `remuxing ${Math.round(fraction * 100)}%`);
    });
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

function concatBlobParts(parts: readonly BlobPart[]): Uint8Array {
  let total = 0;
  const u8s: Uint8Array[] = [];
  for (const p of parts) {
    if (p instanceof Uint8Array) {
      u8s.push(p);
      total += p.byteLength;
    } else if (p instanceof ArrayBuffer) {
      const u = new Uint8Array(p);
      u8s.push(u);
      total += u.byteLength;
    } else {
      throw new Error(`unsupported BlobPart type for remux: ${typeof p}`);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const u of u8s) {
    out.set(u, off);
    off += u.byteLength;
  }
  return out;
}

function isTerminalThrown(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = (err as { code: string }).code;
  return code === "cdm_required"
    || code === "manifest_malformed"
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
 * Sniff the first bytes to decide the real on-disk container, then
 * rename the output filename to match. The plan's outputContainer is the
 * requested target — when our concatenation-only path can't satisfy it
 * we either take a real remux path (MPEG-TS → MP4) or fail before a
 * misleading file reaches disk.
 */
function honestOutput(
  firstSegment: Uint8Array,
  firstSegmentUri: string | undefined,
  plan: HlsPlainPlan | HlsAesPlan,
  hasInitSegment: boolean,
): { mime: string; filename: string } {
  const sniff = sniffContainer(firstSegment, firstSegmentUri);
  const requested = plan.outputContainer;
  if (sniff === "fmp4" && requested === "mp4") return { mime: "video/mp4", filename: plan.outputFilename };
  if (sniff === "fmp4-fragment" && requested === "mp4" && !hasInitSegment) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: firstSegmentUri ?? "",
      parserError: "fMP4 HLS media segments require an EXT-X-MAP init segment",
    };
  }
  if (sniff === "webm" && requested === "webm") return { mime: "video/webm", filename: plan.outputFilename };
  if (sniff === "mpegts") {
    return { mime: "video/mp2t", filename: replaceExt(plan.outputFilename, "ts") };
  }
  return { mime: mimeForContainer(requested), filename: plan.outputFilename };
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

function mimeForContainer(c: string): string {
  switch (c) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mkv": return "video/x-matroska";
    default: return "application/octet-stream";
  }
}
