import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDashJob } from "../../../../src/engine/jobs/dash";
import type { DashPlan, StreamDescriptor, StreamId, VariantId, Variant } from "@savemedia/core";

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>https://x/</BaseURL>
        <SegmentList duration="10000" timescale="1000">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="m1.mp4"/>
          <SegmentURL media="m2.mp4"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

function variant(): Variant {
  return {
    id: "v1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: null,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: null,
    segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
  };
}

function dashDescriptor(): StreamDescriptor {
  return {
    id: "s-dash" as StreamId,
    tabId: 1,
    pageUrl: "https://x/clip.html",
    title: "clip",
    detectedAt: 1,
    source: { kind: "dash-manifest", manifestUrl: "https://x/clip.mpd" },
    protocol: "dash",
    container: "fmp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [variant()],
    drm: null,
    capabilities: { directDownload: false, remuxableTo: ["mp4"], transcodeableTo: ["mp4"], drmBlocked: false },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
  };
}

function plan(): DashPlan {
  return {
    kind: "dash",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "clip.mp4",
    variantId: "v1080" as VariantId,
    audioRenditionId: null,
    estimatedBytes: null,
    useNativeSink: false,
  };
}

let originalFetch: typeof fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:dash");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
});

function bytes(payload: number[]): Response {
  return new Response(new Uint8Array(payload), { status: 200 });
}

function patchFetch(fetcher: (url: string) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => fetcher(String(url))) as unknown as typeof fetch;
}

/** Synthetic ISO-BMFF init segment: 32-byte size + "ftyp" at offset 4. */
function ftypInit(): Response {
  const init = new Uint8Array(16);
  init.set([0x66, 0x74, 0x79, 0x70], 4);
  return new Response(init as BodyInit, { status: 200 });
}

describe("runDashJob", () => {
  it("fetches MPD, init, all media segments → returns Blob URL with the chosen filename", async () => {
    patchFetch(async url => {
      if (url.endsWith(".mpd")) return new Response(MPD, { status: 200 });
      if (url.endsWith("init.mp4")) return ftypInit();
      if (url.endsWith("m1.mp4")) return bytes([1, 2, 3, 4]);
      if (url.endsWith("m2.mp4")) return bytes([5, 6, 7]);
      throw new Error(`unexpected url ${url}`);
    });

    const onProgress = vi.fn();
    const result = await runDashJob(plan(), dashDescriptor(), onProgress, new AbortController().signal);
    expect(result.blobUrl).toBe("blob:dash");
    expect(result.filename).toBe("clip.mp4");
    const phases = onProgress.mock.calls.map(c => c[2]);
    expect(phases).toContain("fetching-manifest");
    expect(phases).toContain("fetching-init");
    expect(phases.some((p: string) => /segment 2\/2/.test(p))).toBe(true);
    expect(phases).toContain("finalizing");
  });

  it("refuses to finalize when the init segment is not a valid MP4 init box", async () => {
    patchFetch(async url => {
      if (url.endsWith(".mpd")) return new Response(MPD, { status: 200 });
      if (url.endsWith("init.mp4")) return bytes([0xDE, 0xAD, 0xBE, 0xEF]); // not an MP4 init
      return bytes([0]);
    });
    await expect(runDashJob(plan(), dashDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "verification_container" });
  });

  it("rejects with manifest_malformed when MPD has no usable track", async () => {
    patchFetch(async url => {
      if (url.endsWith(".mpd")) return new Response("<MPD></MPD>", { status: 200 });
      throw new Error("unexpected");
    });
    await expect(runDashJob(plan(), dashDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });

  it("rejects with manifest_malformed when the source is not a dash-manifest", async () => {
    const wrongSource: StreamDescriptor = {
      ...dashDescriptor(),
      source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
    };
    await expect(runDashJob(plan(), wrongSource, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });
});
