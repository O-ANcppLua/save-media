import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import type { HlsPlainPlan, HlsAesPlan } from "@savemedia/core";
import { hlsDescriptor } from "../../popup/helpers/descriptors";
import type { VariantId } from "@savemedia/core";

function plainPlan(): HlsPlainPlan {
  return {
    kind: "hls-plain",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    variantId: "v-1080" as VariantId,
    estimatedBytes: null,
    useNativeSink: false,
  };
}

function aesPlan(keyUri = "https://x/key.bin"): HlsAesPlan {
  return {
    kind: "hls-aes",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    variantId: "v-1080" as VariantId,
    estimatedBytes: null,
    useNativeSink: false,
    keyUri,
    encryption: { method: "AES-128", keyUri, iv: null },
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

const AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="https://x/key.bin"
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXT-X-ENDLIST
`;

const SAMPLE_AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://x/license"
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXT-X-ENDLIST
`;

let originalFetch: typeof fetch;
let originalSubtle: SubtleCrypto;
let originalCreateObjectURL: typeof URL.createObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalSubtle = globalThis.crypto.subtle;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:fake");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis.crypto, "subtle", { value: originalSubtle, configurable: true });
  URL.createObjectURL = originalCreateObjectURL;
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

describe("runHlsJob — plain", () => {
  it("fetches the media playlist, all segments, and returns a Blob URL", async () => {
    const seg1 = new Uint8Array([1, 2, 3, 4]);
    const seg2 = new Uint8Array([5, 6, 7, 8, 9]);
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      if (url.endsWith("seg1.ts")) return bytesResponse(seg1);
      if (url.endsWith("seg2.ts")) return bytesResponse(seg2);
      throw new Error(`unexpected url ${url}`);
    });

    const onProgress = vi.fn();
    const ac = new AbortController();
    const result = await runHlsJob(plainPlan(), hlsDescriptor(), onProgress, ac.signal);

    expect(result.blobUrl).toBe("blob:fake");
    expect(result.filename).toBe("out.mp4");
    const phases = onProgress.mock.calls.map(c => c[2]);
    expect(phases).toContain("fetching-playlist");
    expect(phases.some((p: string) => /segment 1\/2/.test(p))).toBe(true);
    expect(phases.some((p: string) => /segment 2\/2/.test(p))).toBe(true);
    expect(phases).toContain("finalizing");
  });

  it("aborts when the signal is fired mid-way", async () => {
    const ac = new AbortController();
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      ac.abort(new DOMException("user", "AbortError"));
      throw new DOMException("user", "AbortError");
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws segment_budget_exhausted when too many segments fail", async () => {
    let attempts = 0;
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      attempts++;
      // 404 is not retryable; fast-fail to keep the test deterministic.
      return new Response("not found", { status: 404 });
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "segment_budget_exhausted" });
    expect(attempts).toBeGreaterThan(0);
  }, 10_000);

  it("refuses when the variant has no playlist URL", async () => {
    const d = hlsDescriptor();
    const noUrl = {
      ...d,
      variants: [{
        ...d.variants[0]!,
        segmentRef: { kind: "hls-segments" as const, playlistUrl: "", segmentUrls: [], encryption: null },
      }],
    };
    await expect(runHlsJob(plainPlan(), noUrl, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });
});

describe("runHlsJob — runtime authority over encryption", () => {
  it("decrypts AES-128 even when dispatch produced an hls-plain plan (key lives on media playlist, not master)", async () => {
    const seg1 = new Uint8Array([0x01, 0x02]);
    const seg2 = new Uint8Array([0x03, 0x04]);
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_PLAYLIST);
      if (url.endsWith("key.bin")) return bytesResponse(new Uint8Array(16));
      if (url.endsWith("seg1.ts")) return bytesResponse(seg1);
      if (url.endsWith("seg2.ts")) return bytesResponse(seg2);
      throw new Error(`unexpected ${url}`);
    });
    const decryptCalls: BufferSource[] = [];
    const fakeSubtle = {
      importKey: vi.fn(async () => ({ type: "secret" } as unknown as CryptoKey)),
      decrypt: vi.fn(async (_alg: unknown, _key: unknown, data: BufferSource) => {
        decryptCalls.push(data);
        return new Uint8Array(8).buffer;
      }),
    } as unknown as SubtleCrypto;
    Object.defineProperty(globalThis.crypto, "subtle", { value: fakeSubtle, configurable: true });

    // NOTE: dispatch saw the master and produced an *hls-plain* plan.
    // The runner must still decrypt because the media playlist carries the key.
    await runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal);
    expect(decryptCalls).toHaveLength(2);
  });

  it("refuses SAMPLE-AES at runtime with cdm_required (does NOT ship ciphertext)", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(SAMPLE_AES_PLAYLIST);
      // If the runner ever fetched the segment, we'd know it was about to
      // write ciphertext — make it conspicuous by returning sentinel bytes.
      return bytesResponse(new Uint8Array([0xCC, 0xCC, 0xCC, 0xCC]));
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "SAMPLE-AES" });
  });

  it("renames .mp4 → .ts when the segments are actually MPEG-TS (no false MP4 labels)", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      // TS sync byte 0x47 at the start → engine should detect MPEG-TS.
      if (url.endsWith("seg1.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x10]));
      if (url.endsWith("seg2.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x11]));
      throw new Error(`unexpected ${url}`);
    });
    const result = await runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal);
    expect(result.filename).toBe("out.ts");
  });

  it("keeps the .mp4 filename when segments are fMP4 (init box ftyp / moof)", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      // ISO-BMFF: 4-byte size + 'ftyp' atom at offset 4.
      const ftyp = new Uint8Array(16);
      ftyp.set([0x66, 0x74, 0x79, 0x70], 4);
      if (url.endsWith("seg1.ts")) return bytesResponse(ftyp);
      if (url.endsWith("seg2.ts")) return bytesResponse(ftyp);
      throw new Error(`unexpected ${url}`);
    });
    const result = await runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal);
    expect(result.filename).toBe("out.mp4");
  });
});

describe("runHlsJob — AES-128", () => {
  it("fetches the key, decrypts segments via SubtleCrypto, returns a Blob URL", async () => {
    const key = new Uint8Array(16);
    const ct1 = new Uint8Array([10, 20]);
    const ct2 = new Uint8Array([30, 40]);
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_PLAYLIST);
      if (url.endsWith("key.bin")) return bytesResponse(key);
      if (url.endsWith("seg1.ts")) return bytesResponse(ct1);
      if (url.endsWith("seg2.ts")) return bytesResponse(ct2);
      throw new Error(`unexpected url ${url}`);
    });

    const fakeSubtle = {
      importKey: vi.fn(async () => ({ type: "secret" } as unknown as CryptoKey)),
      decrypt: vi.fn(async (_alg: unknown, _key: unknown, data: BufferSource) => {
        const buf = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
        const out = new Uint8Array(buf.length);
        for (let i = 0; i < buf.length; i++) out[i] = (buf[i]! ^ 0xff) & 0xff;
        return out.buffer;
      }),
    } as unknown as SubtleCrypto;
    Object.defineProperty(globalThis.crypto, "subtle", { value: fakeSubtle, configurable: true });

    const result = await runHlsJob(aesPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal);
    expect(result.blobUrl).toBe("blob:fake");
    expect(fakeSubtle.importKey).toHaveBeenCalledWith(
      "raw",
      expect.any(ArrayBuffer),
      { name: "AES-CBC", length: 128 },
      false,
      ["decrypt"],
    );
    expect(fakeSubtle.decrypt).toHaveBeenCalledTimes(2);
  });

  it("rejects with license_bound_stream when key is not 16 bytes", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_PLAYLIST);
      if (url.endsWith("key.bin")) return bytesResponse(new Uint8Array(8));
      return bytesResponse(new Uint8Array([0]));
    });
    await expect(runHlsJob(aesPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "license_bound_stream" });
  });
});
