import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { hlsDescriptor } from "../../popup/helpers/descriptors";

function plainPlan(): HlsPlainPlan {
  return {
    kind: "hls-plain",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    variantId: "v-1080" as VariantId,
    estimatedBytes: null,
  };
}

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXT-X-ENDLIST
`;

const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:33
#EXTINF:10.0,
seg33.ts
`;

const AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="https://x/key.bin"
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

const SAMPLE_AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://x/license"
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

const FMP4_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg1.m4s
#EXT-X-ENDLIST
`;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function bytesResponse(payload: Uint8Array): Response {
  return new Response(payload as BodyInit, { status: 200 });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function patchFetch(fetcher: (url: string) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => fetcher(String(url))) as unknown as typeof fetch;
}

describe("runHlsJob — supported plain VOD boundary", () => {
  it("fetches a fixed media playlist and attempts TS→MP4 remux instead of saving raw segments as .mp4", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      if (url.endsWith("seg1.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x10]));
      if (url.endsWith("seg2.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x11]));
      throw new Error(`unexpected ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toThrow(/unsupported|format/i);
  });

  it("rejects unknown segment bytes instead of trusting the URL extension", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return bytesResponse(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_layout_unsupported" });
  });

  it("refuses live/sliding-window playlists", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(LIVE_PLAYLIST);
      return bytesResponse(new Uint8Array([0x47]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_live_unsupported" });
  });

  it("refuses HLS AES-128 before fetching keys or ciphertext", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) return textResponse(AES_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });
    patchFetch(fetch);

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_encryption_unsupported", method: "AES-128" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses SAMPLE-AES at runtime with cdm_required", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(SAMPLE_AES_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "SAMPLE-AES" });
  });

  it("refuses HLS fMP4/CMAF playlists until structural validation exists", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(FMP4_MEDIA_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_layout_unsupported" });
  });

  it("throws segment_budget_exhausted when a TS segment cannot be fetched", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return new Response("not found", { status: 404 });
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "segment_budget_exhausted" });
  });
});
