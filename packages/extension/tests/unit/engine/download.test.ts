import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadJob } from "../../../src/engine/download";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor } from "../popup/helpers/descriptors";
import type { UserChoice } from "@savemedia/core";

const baseChoice: UserChoice = {
  outputMode: "Original",
  filename: "clip.mp4",
  variantId: null,
  audioRenditionId: null,
};

let originalFetch: typeof fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:integration");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
});

describe("engine downloadJob — integrates dispatch with job runners", () => {
  it("direct progressive + Original → runDirectJob branch (Blob URL)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]) as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const result = await downloadJob(directDescriptor(), baseChoice, vi.fn(), new AbortController().signal);
    expect(result.filename).toBe("clip.mp4");
    expect(result.blobUrl).toBe("blob:integration");
  });

  it("DRM-blocked descriptor → throws encrypted_media_detected/cdm_required", async () => {
    const d = drmDescriptor("cdm_required");
    await expect(downloadJob(d, baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required" });
  });

  it("ClearKey-deferred descriptor → throws clearkey_deferred", async () => {
    await expect(downloadJob(clearKeyDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "clearkey_deferred" });
  });

  it("DASH descriptor → throws dash_unsupported", async () => {
    await expect(downloadJob(dashDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "dash_unsupported" });
  });

  it("HLS descriptor + unsupported segment bytes → surfaces the HLS refusal", async () => {
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n`;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith(".m3u8")) return new Response(playlist, { status: 200 });
      if (u.endsWith("seg1.ts")) return new Response(new Uint8Array([0x01, 0x02]) as BodyInit, { status: 200 });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    await expect(downloadJob(hlsDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_layout_unsupported" });
  });
});
