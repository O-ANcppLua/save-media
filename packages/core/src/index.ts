export type {
  StreamDescriptor, StreamId, ProtocolFamily, Container, OutputContainer,
  Confidence, ConfidenceLevel, OutputCapabilities,
  DrmStatus, DrmReason, DrmSignalSource, StreamSource,
} from "./types/stream";
export type {
  VideoCodec, AudioCodec, VideoCodecFamily, AudioCodecFamily,
  CodecSet, SubtitleTrack, Variant, VariantId, AudioRenditionId,
  SegmentRef, ByteRange, HlsEncryption,
} from "./types/codec";
export type {
  JobPlan, JobStep, DirectPlan, HlsPlainPlan,
  OutputMode, UserChoice, DispatchRefusal, DispatchRefusalReason,
  VerifyCheckKind,
} from "./types/job";
export type { JobError, JobErrorCode, JobErrorSeverity } from "./errors/taxonomy";
export type { UserMessage, ActionKind } from "./errors/messages";
export type { VerifiedOutput, UnverifiedOutput, VerifyCheck, VerifyResult } from "./engine/verify";
export type { ClassifyInput } from "./classifier/classify";
export type { RetryClass } from "./coordinator/retry";

export { classify } from "./classifier/classify";
export { dispatch, BROWSER_OUTPUT_LIMIT_BYTES } from "./engine/dispatch";
export { verify } from "./engine/verify";
export { userMessage } from "./errors/messages";
export { isTerminal, isRecoverable } from "./errors/taxonomy";
export { computeBackoffMs, isRetryableStatus, RETRY_POLICY } from "./coordinator/retry";
export { parseVideoCodec, parseAudioCodec, friendlyVideoCodec, friendlyAudioCodec } from "./classifier/codec-registry";
export { detectContainerFromBytes, detectContainerFromMime } from "./classifier/container-registry";
export { probeInitSegment } from "./parser/init-segment/probe";
