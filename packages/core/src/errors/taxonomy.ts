import type { DrmSignalSource, OutputContainer, Container } from "../types/stream";
import type { VideoCodec, AudioCodec } from "../types/codec";

export type JobErrorSeverity = "terminal" | "recoverable";

export type JobError =
  // DRM / CDM-bound encryption
  | { code: "encrypted_media_detected";   severity: "terminal";    detectedVia: readonly DrmSignalSource[]; keySystem: string | null }
  | { code: "cdm_required";               severity: "terminal";    keySystem: string }
  | { code: "clear_segments_unavailable"; severity: "terminal";    manifestUrl: string }
  | { code: "license_bound_stream";       severity: "terminal";    keyUri: string; httpStatus: number }
  | { code: "clearkey_deferred";          severity: "terminal";    manifestUrl: string }

  // Source availability
  | { code: "live_window_expired";        severity: "terminal";    missingSegmentsFromStart: number; manifestRefreshAt: number }
  | { code: "manifest_404";               severity: "terminal";    url: string; httpStatus: number }
  | { code: "manifest_malformed";         severity: "terminal";    url: string; parserError: string }

  // Track availability
  | { code: "missing_video_track";        severity: "terminal";    declaredIn: "manifest" | "init-segment" }
  | { code: "no_variant_meets_minimum";   severity: "terminal";    minHeightRequired: 720; maxAvailableHeight: number }

  // Codec compatibility
  | { code: "unsupported_codec";          severity: "terminal";    codec: VideoCodec | AudioCodec; where: "source" | "target" }
  | { code: "no_remux_path";              severity: "terminal";    from: Container; to: OutputContainer; reason: "container-not-supported-by-engine" | "codec-incompatible-with-target" }
  | { code: "unsupported_output";         severity: "terminal";    from: Container; to: OutputContainer; reason: "conversion-not-implemented" | "container-not-supported" }
  | { code: "dash_unsupported";           severity: "terminal";    manifestUrl: string }
  | { code: "hls_encryption_unsupported"; severity: "terminal";    manifestUrl: string; method: string }
  | { code: "hls_live_unsupported";       severity: "terminal";    manifestUrl: string }
  | { code: "hls_layout_unsupported";     severity: "terminal";    manifestUrl: string; detail: string }
  | { code: "output_too_large_for_browser"; severity: "terminal";  estimatedBytes: number; limitBytes: number }

  // Network
  | { code: "segment_fetch_failed";       severity: "recoverable"; segmentIndex: number; url: string; httpStatus: number | "network-error"; attemptsRemaining: number }
  | { code: "segment_budget_exhausted";   severity: "terminal";    failedSegments: readonly number[]; totalSegments: number }
  | { code: "manifest_refresh_failed";    severity: "recoverable"; url: string; httpStatus: number | "network-error"; attemptsRemaining: number }
  | { code: "rate_limited";               severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: 429; retryAfterSeconds: number | null }
  | { code: "server_busy";                severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: number }
  | { code: "access_denied";              severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: 401 | 402 | 403; explanation: "login-or-cookie" | "payment-or-entitlement" | "forbidden-or-expired-url" }
  | { code: "network_unreachable";        severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; detail: string }

  // Browser security
  | { code: "cors_blocked";               severity: "terminal";    url: string; blockedHeader: "Access-Control-Allow-Origin" | "Access-Control-Allow-Headers" | "credentials" }
  | { code: "mixed_content_blocked";      severity: "terminal";    pageProtocol: "https"; resourceProtocol: "http"; url: string }

  // Verification
  | { code: "verification_segment_count"; severity: "terminal";    expected: number; got: number }
  | { code: "verification_duration";      severity: "terminal";    expectedMs: number; gotMs: number; toleranceMs: number }
  | { code: "verification_checksum";      severity: "terminal";    algo: "sha256"; expected: string; got: string }
  | { code: "verification_container";     severity: "terminal";    probeError: string }

  // Engine
  | { code: "engine_job_failed";          severity: "terminal";    at: "manifest" | "init" | "segment" | "finalize"; detail: string }
  | { code: "engine_oom";                 severity: "terminal";    workerMemoryMb: number; budgetMb: 64 }
  | { code: "browser_download_failed";    severity: "terminal";    reason: string; filename: string }

  // Cancellation
  | { code: "user_cancelled";             severity: "terminal";    bytesDiscarded: number };

export type JobErrorCode = JobError["code"];

export function isTerminal(err: JobError): boolean {
  return err.severity === "terminal";
}

export function isRecoverable(err: JobError): boolean {
  return err.severity === "recoverable";
}
