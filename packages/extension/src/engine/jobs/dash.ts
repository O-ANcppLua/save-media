import type { DashPlan, StreamDescriptor } from "@savemedia/core";
import { RETRY_POLICY } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { parseDashJobInputs, type DashTrack } from "../parsers/dash";

/**
 * DASH job runner. Fetches the MPD, resolves init+media URLs for the
 * chosen variant, then concatenates init segment + media segments into a
 * Blob. fMP4/CMAF concatenation produces a valid MP4 for v1; full
 * Mediabunny remux lands later.
 *
 * Audio is currently merged inline only when the same variant carries it.
 * Separate audio renditions are deferred (single-track output for v1).
 */
export async function runDashJob(
  plan: DashPlan,
  descriptor: StreamDescriptor,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<JobResult> {
  if (descriptor.source.kind !== "dash-manifest") {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.pageUrl,
      parserError: "dash plan with non-dash source",
    };
  }

  onProgress(0, null, "fetching-manifest");
  const mpdResp = await fetchWithRetry(descriptor.source.manifestUrl, signal, "manifest");
  const mpdText = await mpdResp.text();
  let inputs;
  try {
    inputs = parseDashJobInputs(
      mpdText,
      descriptor.source.manifestUrl,
      plan.variantId,
      plan.audioRenditionId,
    );
  } catch (err) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.source.manifestUrl,
      parserError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!inputs) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.source.manifestUrl,
      parserError: "no usable video track in MPD",
    };
  }

  return downloadTrack(inputs.video, plan, onProgress, signal);
}

async function downloadTrack(
  track: DashTrack,
  plan: DashPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<JobResult> {
  const parts: BlobPart[] = [];
  let bytesWritten = 0;

  onProgress(0, null, "fetching-init");
  const initResp = await fetchWithRetry(track.initUrl, signal, "segment");
  const initBytes = new Uint8Array(await initResp.arrayBuffer());
  parts.push(initBytes as BlobPart);
  bytesWritten += initBytes.byteLength;

  const failed: number[] = [];
  let consecutive = 0;
  for (let i = 0; i < track.mediaUrls.length; i++) {
    if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");
    try {
      const resp = await fetchWithRetry(track.mediaUrls[i]!, signal, "segment");
      const body = new Uint8Array(await resp.arrayBuffer());
      parts.push(body as BlobPart);
      bytesWritten += body.byteLength;
      consecutive = 0;
      onProgress(bytesWritten, null, `segment ${i + 1}/${track.mediaUrls.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      failed.push(i);
      consecutive += 1;
      const over = failed.length / track.mediaUrls.length > RETRY_POLICY.job.maxFailedSegmentRatio;
      const tooMany = consecutive >= RETRY_POLICY.job.maxConsecutiveFailures;
      if (over || tooMany) {
        throw {
          code: "segment_budget_exhausted",
          severity: "terminal",
          failedSegments: failed,
          totalSegments: track.mediaUrls.length,
        };
      }
    }
  }

  if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");

  onProgress(bytesWritten, bytesWritten, "muxing");
  // The DASH init segment is always fMP4/CMAF → concatenated output is a
  // valid MP4. The plan's outputContainer is honoured (mp4 by default;
  // webm only when explicitly requested and source is WebM CMAF).
  const mime = plan.outputContainer === "webm" ? "video/webm" : "video/mp4";
  const blob = new Blob(parts, { type: mime });
  await assertContainerValid(parts[0], plan.outputContainer);
  onProgress(bytesWritten, bytesWritten, "finalizing");
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: plan.outputFilename,
    checksum: "",
  };
}

async function assertContainerValid(initPart: BlobPart | undefined, expected: DashPlan["outputContainer"]): Promise<void> {
  const { verify } = await import("@savemedia/core");
  const head = initPart instanceof Uint8Array
    ? initPart.subarray(0, 32)
    : initPart instanceof ArrayBuffer
      ? new Uint8Array(initPart).subarray(0, 32)
      : undefined;
  const result = await verify(
    { path: "memory", bytes: 0, checksum: "", head },
    [{ kind: "container-validity", via: "magic-bytes", expected }],
  );
  if (result.kind === "failure") throw result.error;
}
