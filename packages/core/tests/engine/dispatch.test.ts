import { describe, expect, it } from "vitest";
import { dispatch } from "../../src/engine/dispatch";
import type { StreamDescriptor, StreamId } from "../../src/types/stream";
import type { UserChoice } from "../../src/types/job";
import type { Variant, VariantId, HlsEncryption } from "../../src/types/codec";

function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "v-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 50_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: null,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://x/master.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
    ...overrides,
  };
}

function makeDirect(): StreamDescriptor {
  return {
    id: "s1" as StreamId,
    tabId: 1,
    pageUrl: "https://x",
    title: "v",
    detectedAt: 0,
    source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
    protocol: "progressive-http",
    container: "mp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [],
    drm: null,
    capabilities: {
      directDownload: true,
      remuxableTo: ["mp4"],
      transcodeableTo: ["mp4", "webm"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "confirmed", codecs: "guessed" },
  };
}

function makeHls(encryption: HlsEncryption | null = null): StreamDescriptor {
  return {
    id: "s-hls" as StreamId,
    tabId: 1,
    pageUrl: "https://x/index.html",
    title: "hls clip",
    detectedAt: 0,
    source: { kind: "hls-manifest", manifestUrl: "https://x/master.m3u8", type: "master" },
    protocol: "hls",
    container: "fmp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [
      variant({
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://x/v1080.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption,
        },
      }),
    ],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: ["mp4"],
      transcodeableTo: ["mp4", "webm"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
  };
}

function makeDash(): StreamDescriptor {
  return {
    id: "s-dash" as StreamId,
    tabId: 1,
    pageUrl: "https://x/index.html",
    title: "dash clip",
    detectedAt: 0,
    source: { kind: "dash-manifest", manifestUrl: "https://x/clip.mpd" },
    protocol: "dash",
    container: "fmp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [variant({ id: "dash-1080" as VariantId, segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] } })],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: ["mp4"],
      transcodeableTo: ["mp4"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
  };
}

const originalChoice: UserChoice = {
  outputMode: "Original",
  filename: "v.mp4",
  variantId: null,
  audioRenditionId: null,
};

describe("dispatch — DRM refusal", () => {
  it("returns DispatchRefusal for any descriptor.drm value", () => {
    const d = makeDirect();
    const blocked: StreamDescriptor = {
      ...d,
      drm: { reason: "cdm_required", detectedVia: ["eme-hook"], keySystem: "com.widevine.alpha" },
      capabilities: { ...d.capabilities, drmBlocked: true },
    };
    const r = dispatch(blocked, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("ClearKey returns clearkey_deferred reason distinct from CDM-block", () => {
    const d = { ...makeDash(), drm: { reason: "clearkey_deferred" as const, detectedVia: ["dash-content-protection" as const, "clearkey-detector" as const], keySystem: "org.w3.clearkey" }, capabilities: { ...makeDash().capabilities, drmBlocked: true } };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("clearkey_deferred");
  });
});

describe("dispatch — direct", () => {
  it("progressive + Original + direct-url → DirectPlan", () => {
    const r = dispatch(makeDirect(), originalChoice);
    expect(r.kind).toBe("direct");
    if (r.kind === "direct") {
      expect(r.url).toBe("https://x/v.mp4");
      expect(r.filename).toBe("v.mp4");
    }
  });

  it("HLS does not produce a direct plan even when capabilities allow it", () => {
    const d = { ...makeHls(), capabilities: { ...makeHls().capabilities, directDownload: true } };
    const r = dispatch(d, originalChoice);
    expect(r.kind).not.toBe("direct");
  });
});

describe("dispatch — HLS", () => {
  it("clear HLS → hls-plain plan with chosen variant", () => {
    const r = dispatch(makeHls(), { ...originalChoice, variantId: "v-1080" as VariantId });
    expect(r.kind).toBe("hls-plain");
    if (r.kind === "hls-plain") {
      expect(r.variantId).toBe("v-1080");
      expect(r.outputContainer).toBe("mp4");
      expect(r.steps.find(s => s.op === "remux")).toBeDefined();
      expect(r.steps.find(s => s.op === "verify")).toBeDefined();
      expect(r.steps.find(s => s.op === "finalize")).toBeDefined();
      expect(r.useNativeSink).toBe(false);
    }
  });

  it("AES-128 HLS → hls-aes plan with key URI + steps including fetch-key + decrypt", () => {
    const enc: HlsEncryption = { method: "AES-128", keyUri: "https://x/key.bin", iv: null };
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("hls-aes");
    if (r.kind === "hls-aes") {
      expect(r.keyUri).toBe("https://x/key.bin");
      expect(r.encryption.method).toBe("AES-128");
      expect(r.steps.find(s => s.op === "fetch-key")).toBeDefined();
      expect(r.steps.find(s => s.op === "decrypt-aes-128")).toBeDefined();
    }
  });

  it("SAMPLE-AES HLS variant → refuses with cdm_required", () => {
    const enc = { method: "SAMPLE-AES", keyUri: "https://x/k", iv: null } as HlsEncryption;
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("HLS with no variants → refuses with clear_segments_unavailable", () => {
    const d = { ...makeHls(), variants: [] };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("clear_segments_unavailable");
  });

  it("HLS estimatedSize above 2 GiB toggles useNativeSink=true", () => {
    const base = makeHls();
    const huge: StreamDescriptor = {
      ...base,
      variants: [variant({ estimatedSize: 3 * 1024 * 1024 * 1024 })],
    };
    const r = dispatch(huge, originalChoice);
    if (r.kind !== "hls-plain") throw new Error("expected hls-plain");
    expect(r.useNativeSink).toBe(true);
    expect(r.steps.find(s => s.op === "finalize")).toMatchObject({ sink: "native-streaming-sink" });
  });
});

describe("dispatch — DASH", () => {
  it("clear DASH → dash plan with chosen variant + audioRenditionId", () => {
    const r = dispatch(makeDash(), { ...originalChoice, variantId: "dash-1080" as VariantId });
    expect(r.kind).toBe("dash");
    if (r.kind === "dash") {
      expect(r.variantId).toBe("dash-1080");
      expect(r.outputContainer).toBe("mp4");
    }
  });
});

describe("dispatch — remux / transcode for progressive containers", () => {
  it("progressive WebM + Original mode (output stays webm) → direct plan", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "webm",
      source: { kind: "direct-url", url: "https://x/v.webm", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["webm", "mp4"],
        transcodeableTo: ["mp4", "webm"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("direct");
  });

  it("progressive MKV + MP4 Compatible → remux plan when remux is supported", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "mkv",
      source: { kind: "direct-url", url: "https://x/v.mkv", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["mp4", "mkv"],
        transcodeableTo: ["mp4"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, { ...originalChoice, outputMode: "MP4 Compatible" });
    expect(r.kind).toBe("remux");
    if (r.kind === "remux") {
      expect(r.fromContainer).toBe("mkv");
      expect(r.outputContainer).toBe("mp4");
    }
  });

  it("progressive AVI + MP4 Compatible (no remux path) → transcode plan when transcode supports it", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "avi",
      source: { kind: "direct-url", url: "https://x/v.avi", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: [],
        transcodeableTo: ["mp4"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, { ...originalChoice, outputMode: "MP4 Compatible" });
    expect(r.kind).toBe("transcode");
    if (r.kind === "transcode") {
      expect(r.outputContainer).toBe("mp4");
      expect(r.engine).toBe("ffmpeg-wasm");
    }
  });

  it("progressive with no remux nor transcode path → refuse", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "avi",
      source: { kind: "direct-url", url: "https://x/v.avi", headers: {} },
      capabilities: { directDownload: true, remuxableTo: [], transcodeableTo: [], drmBlocked: false },
    };
    const r = dispatch(d, { ...originalChoice, outputMode: "MP4 Compatible" });
    expect(r.kind).toBe("refuse");
  });
});

describe("dispatch — variant selection", () => {
  it("prefers the explicitly chosen variantId when present", () => {
    const d: StreamDescriptor = {
      ...makeHls(),
      variants: [
        variant({ id: "v-720" as VariantId, height: 720 }),
        variant({ id: "v-1080" as VariantId, height: 1080 }),
      ],
    };
    const r = dispatch(d, { ...originalChoice, variantId: "v-720" as VariantId });
    if (r.kind !== "hls-plain") throw new Error("expected hls-plain");
    expect(r.variantId).toBe("v-720");
  });

  it("falls back to highest height when no variantId is selected", () => {
    const d: StreamDescriptor = {
      ...makeHls(),
      variants: [
        variant({ id: "v-720" as VariantId, height: 720, bitrate: 3_000_000 }),
        variant({ id: "v-1080" as VariantId, height: 1080, bitrate: 5_000_000 }),
      ],
    };
    const r = dispatch(d, originalChoice);
    if (r.kind !== "hls-plain") throw new Error("expected hls-plain");
    expect(r.variantId).toBe("v-1080");
  });
});
