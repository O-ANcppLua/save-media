import type { JobError } from "./taxonomy";

export type ActionKind =
  | "retry-job" | "retry-from-now" | "override-min-quality"
  | "open-settings" | "open-docs";

export interface UserMessage {
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly kind: ActionKind } | null;
}

function formatBytes(b: number): string {
  if (b < 1e6) return `${(b / 1e3).toFixed(1)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}

export function userMessage(err: JobError): UserMessage {
  switch (err.code) {
    case "encrypted_media_detected":
    case "cdm_required":
    case "license_bound_stream":
      return {
        title: "This stream is protected",
        body: "savemedia cannot decrypt or bypass DRM-protected media. The site uses an encrypted media license workflow that browsers handle inside a hardware-isolated decoder; the decrypted frames are never made available to extensions.",
        action: null,
      };

    case "clear_segments_unavailable":
      return {
        title: "Stream is encrypted end-to-end",
        body: "All segments in this stream are encrypted with no accessible decryption key. This is a DRM-protected stream and cannot be saved.",
        action: null,
      };

    case "clearkey_deferred":
      return {
        title: "ClearKey / CENC decryption is not implemented",
        body: "This stream uses ClearKey / CENC sample-encryption. The keys may be visible to the browser, but savemedia does not implement the per-sample AES-CTR decryptor needed to save this stream.",
        action: null,
      };

    case "live_window_expired":
      return {
        title: "Live segments no longer available",
        body: `The first ${err.missingSegmentsFromStart} segments of this live stream have already aged out of the playback window. Start a new download to capture only the segments still available.`,
        action: { label: "Start new download from current position", kind: "retry-from-now" },
      };

    case "manifest_404":
      return {
        title: "Manifest unavailable",
        body: `The streaming manifest at ${err.url} returned HTTP ${err.httpStatus}. The stream may have been removed or moved.`,
        action: null,
      };

    case "manifest_malformed":
      return {
        title: "Manifest could not be parsed",
        body: `The streaming manifest at ${err.url} is malformed. Parser error: ${err.parserError}`,
        action: null,
      };

    case "missing_video_track":
      return {
        title: "No video track in source",
        body: `The source advertises no video track in its ${err.declaredIn}. savemedia only handles complete video items — audio-only streams are out of scope.`,
        action: null,
      };

    case "no_variant_meets_minimum":
      return {
        title: "Source quality is below 720p",
        body: `The highest available quality is ${err.maxAvailableHeight}p. savemedia treats sub-720p sources as below minimum quality. Continue anyway to download at ${err.maxAvailableHeight}p?`,
        action: { label: "Download anyway", kind: "override-min-quality" },
      };

    case "unsupported_codec":
      return {
        title: "Codec not supported in selected output",
        body: `${err.codec.rfc6381 ?? err.codec.family} cannot be ${err.where === "source" ? "decoded" : "produced"} by the current in-browser engine. Choose Original if the browser can save the source container directly.`,
        action: { label: "Open Settings", kind: "open-settings" },
      };

    case "no_remux_path":
      return {
        title: "Can't remux to chosen container",
        body: `Cannot remux from ${err.from} to ${err.to}: ${err.reason}. savemedia will not write a misleading file with the wrong extension.`,
        action: null,
      };

    case "unsupported_output":
      return {
        title: "That conversion is not implemented",
        body: `This source is ${err.from}, but the selected output is ${err.to}. Only direct saves and tested stream remux paths are enabled; choose Original when available.`,
        action: null,
      };

    case "dash_unsupported":
      return {
        title: "DASH is not supported",
        body: `DASH was detected at ${err.manifestUrl}, but savemedia only downloads verified direct video files and plain HLS VOD playlists.`,
        action: null,
      };

    case "hls_encryption_unsupported":
      return {
        title: "Encrypted HLS is not supported",
        body: `This HLS playlist uses ${err.method}. savemedia does not download encrypted HLS streams; it only downloads plain HLS VOD playlists.`,
        action: null,
      };

    case "hls_live_unsupported":
      return {
        title: "Live HLS is not supported",
        body: `The playlist at ${err.manifestUrl} is a live/sliding-window stream. savemedia only downloads complete HLS VOD playlists with a fixed end.`,
        action: null,
      };

    case "hls_layout_unsupported":
      return {
        title: "This HLS layout is not supported",
        body: `${err.detail} savemedia only downloads plain HLS VOD playlists that can be remuxed into one verified final video.`,
        action: null,
      };

    case "output_too_large_for_browser":
      return {
        title: "File is too large for the in-browser saver",
        body: `Estimated output is ${formatBytes(err.estimatedBytes)}, above the ${formatBytes(err.limitBytes)} browser Blob limit used by this extension. The download was stopped before risking a corrupt partial file.`,
        action: null,
      };

    case "segment_fetch_failed":
      return {
        title: "Segment retry in progress",
        body: `Segment ${err.segmentIndex} failed (HTTP ${err.httpStatus}). ${err.attemptsRemaining} retries remaining.`,
        action: null,
      };

    case "segment_budget_exhausted":
      return {
        title: "A required segment could not be downloaded",
        body: `${err.failedSegments.length} of ${err.totalSegments} required segments failed after retries. The partial file has been deleted instead of saving a broken video.`,
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "manifest_refresh_failed":
      return {
        title: "Live manifest refresh failed",
        body: `Could not refresh the live playlist at ${err.url} (HTTP ${err.httpStatus}). ${err.attemptsRemaining} retries remaining.`,
        action: null,
      };

    case "rate_limited":
      return {
        title: "Server rate-limited the download",
        body: err.retryAfterSeconds
          ? `The server returned HTTP 429 during ${err.phase} download and asked to retry after ${err.retryAfterSeconds}s. Wait a bit, then retry.`
          : `The server returned HTTP 429 during ${err.phase} download. Wait a bit, then retry.`,
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "server_busy":
      return {
        title: "Server is busy or unstable",
        body: `The server returned HTTP ${err.httpStatus} during ${err.phase} download after retries. This is not DRM; retry later or try a lower-quality variant if one exists.`,
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "access_denied":
      return {
        title: "The site denied access",
        body: accessDeniedBody(err.httpStatus, err.explanation),
        action: null,
      };

    case "network_unreachable":
      return {
        title: "Network request failed",
        body: `The browser could not fetch the ${err.phase} URL. This can be network loss, an expired signed URL, or a browser/security restriction. Detail: ${err.detail}`,
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "cors_blocked":
      return {
        title: "Browser blocked the request",
        body: `The browser refused to fetch from this origin because the server didn't allow it (missing ${err.blockedHeader}). This is a server-side restriction; savemedia cannot work around it.`,
        action: null,
      };

    case "mixed_content_blocked":
      return {
        title: "Mixed content blocked",
        body: "The page is HTTPS but the media resource is HTTP. Browsers block this. The site needs to serve media over HTTPS.",
        action: null,
      };

    case "verification_segment_count":
    case "verification_duration":
    case "verification_checksum":
    case "verification_container":
      return {
        title: "Download verification failed",
        body: "The downloaded file did not pass integrity checks. It has been deleted so it cannot be mistaken for a complete download.",
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "engine_job_failed":
      return {
        title: "Download engine failed",
        body: `The browser-side download engine failed at the ${err.at} stage: ${err.detail}. The partial file was discarded.`,
        action: null,
      };

    case "engine_oom":
      return {
        title: "Out of memory",
        body: `The download engine exceeded its ${err.budgetMb} MB budget while processing this stream. Try a lower quality variant.`,
        action: null,
      };

    case "browser_download_failed":
      return {
        title: "Browser download failed",
        body: `The browser refused or interrupted saving ${err.filename}: ${err.reason}. Check disk space, Downloads permissions, and browser download settings.`,
        action: null,
      };

    case "user_cancelled":
      return {
        title: "Cancelled",
        body: `Download cancelled by user. ${formatBytes(err.bytesDiscarded)} discarded.`,
        action: null,
      };
  }
}

function accessDeniedBody(status: 401 | 402 | 403, explanation: string): string {
  if (status === 402 || explanation === "payment-or-entitlement") {
    return "The server requires an account, entitlement, purchase, or other access token for this URL. This is access control, not automatically DRM; savemedia cannot invent credentials it does not have.";
  }
  if (explanation === "login-or-cookie") {
    return "The server requires a logged-in session or cookie that was not accepted for this request. Open the video page while logged in, then retry.";
  }
  return "The server returned forbidden/expired access. This can be an expired signed URL, geo/account restriction, or site-side block. It is not treated as DRM unless an actual DRM signal is detected.";
}
