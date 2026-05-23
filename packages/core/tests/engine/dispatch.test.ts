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
    container: "mpegts",
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
    }
  });

  it("AES-128 HLS → refuses instead of producing a decrypt plan", () => {
    const enc: HlsEncryption = { method: "AES-128", keyUri: "https://x/key.bin", iv: null };
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "hls_encryption_unsupported" });
  });

  it("SAMPLE-AES HLS variant → refuses with cdm_required", () => {
    const enc = { method: "SAMPLE-AES", keyUri: "https://x/k", iv: null } as HlsEncryption;
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("HLS with no variants → refuses with no_usable_variant", () => {
    const d = { ...makeHls(), variants: [] };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("no_usable_variant");
  });

  it("HLS estimatedSize above 2 GiB refuses before risking a corrupt browser Blob", () => {
    const base = makeHls();
    const huge: StreamDescriptor = {
      ...base,
      variants: [variant({ estimatedSize: 3 * 1024 * 1024 * 1024 })],
    };
    const r = dispatch(huge, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });
});

describe("dispatch — DASH", () => {
  it("clear DASH → refuses instead of producing a download plan", () => {
    const r = dispatch(makeDash(), { ...originalChoice, variantId: "dash-1080" as VariantId });
    expect(r).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });
});

describe("dispatch — progressive containers", () => {
  it("progressive WebM + Original mode (output stays webm) → direct plan", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "webm",
      source: { kind: "direct-url", url: "https://x/v.webm", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["webm", "mp4"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("direct");
  });

  it("progressive MKV + Original mode → direct plan", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "mkv",
      source: { kind: "direct-url", url: "https://x/v.mkv", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["mp4", "mkv"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("direct");
  });

  it("progressive direct-url without direct-download capability refuses instead of inventing a conversion", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "mp4",
      source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
      capabilities: {
        directDownload: false,
        remuxableTo: [],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "unsupported_output" });
  });

  it("unknown protocol direct-url refuses instead of best-effort downloading", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      protocol: "unknown",
      confidence: { protocol: "guessed", container: "guessed", codecs: "guessed" },
      capabilities: {
        directDownload: false,
        remuxableTo: [],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "unsupported_output" });
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
