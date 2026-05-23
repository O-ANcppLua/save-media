declare const STREAM_ID_BRAND: unique symbol;
export type StreamId = string & { readonly [STREAM_ID_BRAND]: true };

declare const VARIANT_ID_BRAND: unique symbol;
export type VariantId = string & { readonly [VARIANT_ID_BRAND]: true };

declare const RENDITION_ID_BRAND: unique symbol;
export type AudioRenditionId = string & { readonly [RENDITION_ID_BRAND]: true };

export type ProtocolFamily = "progressive-http" | "hls" | "dash" | "unknown";

export type Container =
  | "mp4" | "webm" | "mkv"
  | "mpegts" | "fmp4" | "cmaf"
  | "unknown";

export type OutputContainer = "mp4" | "webm" | "mkv";

export type ConfidenceLevel = "guessed" | "probable" | "confirmed";

export interface Confidence {
  readonly container: ConfidenceLevel;
  readonly codecs: ConfidenceLevel;
  readonly protocol: ConfidenceLevel;
}

export interface OutputCapabilities {
  readonly directDownload: boolean;
  readonly remuxableTo: readonly OutputContainer[];
  readonly drmBlocked: boolean;
}

export type DrmReason =
  | "encrypted_media_detected"
  | "cdm_required"
  | "clear_segments_unavailable"
  | "license_bound_stream"
  | "clearkey_deferred";

export type DrmSignalSource =
  | "eme-hook"
  | "mediasource-probe"
  | "hls-ext-x-key"
  | "dash-content-protection"
  | "clearkey-detector";

export type DrmStatus =
  | null
  | {
      readonly reason: DrmReason;
      readonly detectedVia: readonly DrmSignalSource[];
      readonly keySystem: string | null;
    };

export type StreamSource =
  | { readonly kind: "direct-url"; readonly url: string; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" }
  | { readonly kind: "dash-manifest"; readonly manifestUrl: string }
  | { readonly kind: "media-element"; readonly element: "video" | "audio"; readonly elementSrc: string };

import type { CodecSet, Variant } from "./codec";

export interface StreamDescriptor {
  readonly id: StreamId;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly title: string | null;
  readonly detectedAt: number;
  readonly source: StreamSource;
  readonly protocol: ProtocolFamily;
  readonly container: Container;
  readonly codecs: CodecSet;
  readonly variants: readonly Variant[];
  readonly drm: DrmStatus;
  readonly capabilities: OutputCapabilities;
  readonly confidence: Confidence;
}
