import type {
  StreamDescriptor,
  StreamId,
  ProtocolFamily,
  Container,
  Confidence,
  ConfidenceLevel,
  OutputCapabilities,
  DrmStatus,
  StreamSource,
} from "../types/stream";
import type { CodecSet, SegmentRef, Variant } from "../types/codec";
import { classifyByUrl } from "./layer-url";
import { classifyByHeaders } from "./layer-headers";
import { classifyByMagicBytes } from "./layer-magic-bytes";
import { parseHlsMaster, parseHlsMediaPlaylist } from "../parser/hls/adapter";
import { interpretHlsEncryption } from "../parser/hls/encryption";
import { parseDash } from "../parser/dash/adapter";

export interface ClassifyInput {
  readonly tabId: number;
  readonly pageUrl: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes: Uint8Array | null;
  readonly manifestText: string | null;
}

let _idCounter = 0;

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  guessed: 0,
  probable: 1,
  confirmed: 2,
};

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  return {
    protocol:
      CONFIDENCE_RANK[a.protocol] >= CONFIDENCE_RANK[b.protocol]
        ? a.protocol
        : b.protocol,
    container:
      CONFIDENCE_RANK[a.container] >= CONFIDENCE_RANK[b.container]
        ? a.container
        : b.container,
    codecs:
      CONFIDENCE_RANK[a.codecs] >= CONFIDENCE_RANK[b.codecs]
        ? a.codecs
        : b.codecs,
  };
}

// Direct-download containers are standalone files, not manifests.
const PROGRESSIVE_CONTAINERS = new Set<Container>([
  "mp4", "m4v", "mov", "webm", "mkv", "mpegts", "avi", "wmv", "flv",
]);

function resolveProtocol(
  fromLayers: ProtocolFamily,
  container: Container,
): ProtocolFamily {
  if (fromLayers !== "unknown") return fromLayers;
  if (PROGRESSIVE_CONTAINERS.has(container)) return "progressive-http";
  return "unknown";
}

function remuxableTargets(container: Container): readonly ("mp4" | "webm" | "mkv")[] {
  if (
    container === "mp4" ||
    container === "fmp4" ||
    container === "cmaf" ||
    container === "m4v"
  )
    return ["mp4"];
  if (container === "webm") return ["webm", "mp4"];
  if (container === "mkv") return ["mp4", "mkv"];
  if (container === "mpegts") return ["mp4"];
  return [];
}

function computeCapabilities(
  protocol: ProtocolFamily,
  container: Container,
  _variants: readonly Variant[],
  drm: DrmStatus,
): OutputCapabilities {
  const drmBlocked = drm !== null;
  return {
    directDownload: !drmBlocked && protocol === "progressive-http",
    remuxableTo: drmBlocked ? [] : remuxableTargets(container),
    transcodeableTo: drmBlocked ? [] : ["mp4", "webm"],
    drmBlocked,
  };
}

function buildSource(
  url: string,
  protocol: ProtocolFamily,
  headers: Readonly<Record<string, string>>,
  hlsManifestType: "master" | "media" = "master",
): StreamSource {
  if (protocol === "hls")
    return { kind: "hls-manifest", manifestUrl: url, type: hlsManifestType };
  if (protocol === "dash") return { kind: "dash-manifest", manifestUrl: url };
  return { kind: "direct-url", url, headers };
}

function hlsContainerFromSegments(segmentRef: SegmentRef): Container {
  if (segmentRef.kind !== "hls-segments") return "unknown";
  if (segmentRef.initSegmentUrl) return "fmp4";
  const first = segmentRef.segmentUrls[0] ?? "";
  if (/\.(ts|mpegts)(\?|#|$)/i.test(first)) return "mpegts";
  if (/\.(m4s|mp4|m4v)(\?|#|$)/i.test(first)) return "fmp4";
  return "unknown";
}

function mediaPlaylistVariant(
  url: string,
  media: ReturnType<typeof parseHlsMediaPlaylist>,
  encryption: ReturnType<typeof interpretHlsEncryption>["encryption"],
): Variant {
  return {
    id: `${url}#media` as Variant["id"],
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: null,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: null,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: url,
      initSegmentUrl: media.initSegmentUrl,
      segmentUrls: media.segments.map(s => s.uri),
      encryption,
    },
  };
}

export async function classify(input: ClassifyInput): Promise<StreamDescriptor> {
  const l1 = classifyByUrl(input.url);
  const l2 = classifyByHeaders(input.headers);

  // Pick the more-confident signal for each dimension.
  let protocol: ProtocolFamily =
    l2.protocol !== "unknown" ? l2.protocol : l1.protocol;
  let container: Container =
    l2.container !== "unknown" ? l2.container : l1.container;
  let confidence = mergeConfidence(l1.confidence, l2.confidence);
  const title: string | null = l2.titleHint;
  let variants: Variant[] = [];
  let drm: DrmStatus = null;
  const codecs: CodecSet = { video: null, audio: null, subtitles: [] };
  let hlsManifestType: "master" | "media" = "master";

  // Layer 3: manifest parse
  if (protocol === "hls" && input.manifestText) {
    const r = parseHlsMaster(input.manifestText, input.url);
    variants = [...r.variants];
    confidence = { ...confidence, protocol: "confirmed" };

    // Only attempt media-playlist encryption scan when there are no variant
    // playlists (i.e. the text is itself a media playlist, not a master).
    if (variants.length === 0) {
      try {
        const media = parseHlsMediaPlaylist(input.manifestText, input.url);
        const enc = interpretHlsEncryption(media.encryption);
        if (enc.drm) drm = enc.drm;
        hlsManifestType = "media";
        const variant = mediaPlaylistVariant(input.url, media, enc.encryption);
        variants = [variant];
        container = hlsContainerFromSegments(variant.segmentRef);
        if (container !== "unknown") {
          confidence = { ...confidence, container: "probable" };
        }
      } catch {
        // Not a media playlist; skip.
      }
    }
  } else if (protocol === "dash" && input.manifestText) {
    const r = parseDash(input.manifestText, input.url);
    variants = [...r.videoVariants];
    drm = r.drm;
    confidence = { ...confidence, protocol: "confirmed" };
  }

  // Layer 4: magic-byte sniff
  if (input.bodyBytes && input.bodyBytes.length > 0) {
    const l4 = classifyByMagicBytes(input.bodyBytes);
    if (l4.container !== "unknown") {
      container = l4.container;
      confidence = mergeConfidence(confidence, l4.confidence);
    }
  }

  // Layer 5 (init-segment probe) is invoked separately by the caller after
  // they fetch the init segment.

  // Resolve protocol after all layers so magic-bytes can inform the decision.
  protocol = resolveProtocol(protocol, container);

  const capabilities = computeCapabilities(protocol, container, variants, drm);
  const id = `stream-${++_idCounter}` as StreamId;

  return {
    id,
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    title,
    detectedAt: Date.now(),
    source: buildSource(input.url, protocol, input.headers, hlsManifestType),
    protocol,
    container,
    codecs,
    variants,
    drm,
    capabilities,
    confidence,
  };
}
