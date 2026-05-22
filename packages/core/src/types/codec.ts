import type { VariantId, AudioRenditionId } from "./stream";
export type { VariantId, AudioRenditionId };

export type VideoCodecFamily =
  | "h264" | "h265" | "vp8" | "vp9" | "av1"
  | "mpeg4-part2" | "prores" | "unknown";

export type AudioCodecFamily =
  | "aac" | "mp3" | "opus" | "vorbis" | "flac" | "pcm"
  | "alac" | "ac3" | "eac3" | "unknown";

export interface VideoCodec {
  readonly rfc6381: string;
  readonly family: VideoCodecFamily;
  readonly profile: string | null;
  readonly level: string | null;
}

export interface AudioCodec {
  readonly rfc6381: string | null;
  readonly family: AudioCodecFamily;
  readonly channels: number | null;
  readonly sampleRate: number | null;
}

export interface SubtitleTrack {
  readonly id: string;
  readonly language: string | null;
  readonly format: "vtt" | "ttml" | "srt" | "unknown";
  readonly url: string;
}

export interface CodecSet {
  readonly video: VideoCodec | null;
  readonly audio: AudioCodec | null;
  readonly subtitles: readonly SubtitleTrack[];
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface HlsEncryption {
  readonly method: "AES-128" | "SAMPLE-AES" | "SAMPLE-AES-CTR";
  readonly keyUri: string;
  readonly iv: Uint8Array | null;
}

export type SegmentRef =
  | { readonly kind: "direct"; readonly url: string }
  | { readonly kind: "byte-range"; readonly url: string; readonly range: ByteRange }
  | {
      readonly kind: "hls-segments";
      readonly playlistUrl: string;
      readonly initSegmentUrl: string | null;
      readonly segmentUrls: readonly string[];
      readonly encryption: HlsEncryption | null;
    }
  | {
      readonly kind: "dash-segments";
      readonly initUrl: string;
      readonly mediaUrls: readonly string[];
    };

export interface Variant {
  readonly id: VariantId;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly bitrate: number | null;
  readonly estimatedSize: number | null;
  readonly videoCodec: VideoCodec | null;
  readonly audioCodec: AudioCodec | null;
  readonly audioRenditionId: AudioRenditionId | null;
  readonly segmentRef: SegmentRef;
}
