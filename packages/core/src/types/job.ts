import type { DrmReason, OutputContainer } from "./stream";
import type { VariantId, AudioRenditionId, ByteRange } from "./codec";

export type OutputMode = "Original";

export interface UserChoice {
  readonly outputMode: OutputMode;
  readonly filename: string;
  readonly variantId: VariantId | null;
  readonly audioRenditionId: AudioRenditionId | null;
}

export interface DispatchRefusal {
  readonly kind: "refuse";
  readonly reason: DispatchRefusalReason;
}

export type DispatchRefusalReason =
  | DrmReason
  | "no_usable_variant"
  | "unsupported_output"
  | "output_too_large_for_browser"
  | "dash_unsupported"
  | "hls_encryption_unsupported"
  | "hls_live_unsupported";

export type VerifyCheckKind =
  | "segment-count" | "duration" | "byte-checksum" | "container-validity";

export type JobStep =
  | { readonly op: "fetch-segment"; readonly index: number; readonly url: string; readonly range?: ByteRange; readonly iv?: Uint8Array }
  | { readonly op: "remux"; readonly toContainer: OutputContainer }
  | { readonly op: "verify"; readonly checks: readonly VerifyCheckKind[] }
  | { readonly op: "finalize"; readonly sink: "downloads" };

export interface DirectPlan {
  readonly kind: "direct";
  readonly url: string;
  readonly filename: string;
}

export interface HlsPlainPlan {
  readonly kind: "hls-plain";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly variantId: VariantId;
  readonly estimatedBytes: number | null;
}

export type JobPlan = DirectPlan | HlsPlainPlan;
