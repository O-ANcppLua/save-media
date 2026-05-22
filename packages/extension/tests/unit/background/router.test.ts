import { describe, it, expect, vi } from "vitest";
import { createRouter, drmRefusalToError } from "../../../src/background/router";
import { directDescriptor, hlsDescriptor, drmDescriptor, clearKeyDescriptor } from "../popup/helpers/descriptors";
import type { UserChoice, StreamDescriptor, StreamId, VariantId } from "@savemedia/core";

function deps() {
  return {
    runtime: { sendMessage: vi.fn() },
    downloads: { download: vi.fn(async () => 1) },
    ensureEngineHost: vi.fn(async () => undefined),
  };
}

function choice(overrides: Partial<UserChoice> = {}): UserChoice {
  return {
    outputMode: "Original",
    filename: "clip.mp4",
    variantId: null,
    audioRenditionId: null,
    ...overrides,
  };
}

describe("router — descriptor de-duplication", () => {
  it("adds a descriptor once and reports false on duplicates", () => {
    const r = createRouter(deps());
    const d = directDescriptor();
    expect(r.addDescriptor(1, d)).toBe(true);
    expect(r.addDescriptor(1, d)).toBe(false);
    expect(r.listDescriptors(1)).toHaveLength(1);
  });

  it("isolates descriptors per tab", () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    r.addDescriptor(2, hlsDescriptor());
    expect(r.listDescriptors(1)).toHaveLength(1);
    expect(r.listDescriptors(2)).toHaveLength(1);
  });

  it("clears tab descriptors on clearTab", () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    r.clearTab(1);
    expect(r.listDescriptors(1)).toHaveLength(0);
  });

  it("drops an HLS media-playlist descriptor when its master variant is already known", () => {
    const r = createRouter(deps());
    const master = hlsDescriptor({
      variants: [{
        ...hlsDescriptor().variants[0]!,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://cdn/video/720p.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      }],
    });
    const media = hlsMediaDescriptor("https://cdn/video/720p.m3u8");

    expect(r.addDescriptor(1, master)).toBe(true);
    expect(r.addDescriptor(1, media)).toBe(false);
    expect(r.listDescriptors(1).map(d => d.id)).toEqual([master.id]);
  });

  it("replaces a standalone HLS media-playlist descriptor when its master arrives later", () => {
    const r = createRouter(deps());
    const media = hlsMediaDescriptor("https://cdn/video/720p.m3u8");
    const master = hlsDescriptor({
      variants: [{
        ...hlsDescriptor().variants[0]!,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://cdn/video/720p.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      }],
    });

    expect(r.addDescriptor(1, media)).toBe(true);
    expect(r.addDescriptor(1, master)).toBe(true);
    expect(r.listDescriptors(1).map(d => d.id)).toEqual([master.id]);
  });
});

describe("router — startDownload routing", () => {
  it("routes a direct stream through chrome.downloads.download", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());
    const err = await r.startDownload(directDescriptor().id, choice());
    expect(err).toBeNull();
    expect(d.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/clip.mp4",
        filename: "clip.mp4",
        conflictAction: "uniquify",
      }),
    );
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });

  it("routes an HLS stream through the engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, hlsDescriptor());
    const err = await r.startDownload(hlsDescriptor().id, choice({ variantId: "v-1080" as VariantId }));
    expect(err).toBeNull();
    expect(d.ensureEngineHost).toHaveBeenCalledTimes(1);
    expect(d.runtime.sendMessage).toHaveBeenCalled();
    expect(r.jobs.get(hlsDescriptor().id)).toBeDefined();
  });

  it("refuses DRM-blocked streams without calling engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));
    const err = await r.startDownload(drmDescriptor("cdm_required").id, choice());
    expect(err?.code).toBe("cdm_required");
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });

  it("refuses ClearKey with the deferred reason code", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, clearKeyDescriptor());
    const err = await r.startDownload(clearKeyDescriptor().id, choice());
    expect(err?.code).toBe("clearkey_deferred");
  });

  it("returns manifest_404 when streamId is unknown", async () => {
    const r = createRouter(deps());
    const err = await r.startDownload("nope" as StreamId, choice());
    expect(err?.code).toBe("manifest_404");
  });

  it("translates chrome.downloads errors into native_sink_io_error", async () => {
    const d = deps();
    d.downloads.download.mockRejectedValueOnce(new Error("ENOSPC"));
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());
    const err = await r.startDownload(directDescriptor().id, choice());
    expect(err?.code).toBe("native_sink_io_error");
  });
});

describe("router — engine message handling", () => {
  it("forwards progress messages to popup payload shape", async () => {
    const r = createRouter(deps());
    const id = directDescriptor().id;
    const out = await r.handleEngineMessage({
      type: "progress",
      streamId: id,
      bytesWritten: 1,
      bytesTotal: 2,
      phase: "muxing",
    });
    expect(out).toEqual({
      type: "job-progress",
      streamId: id,
      bytesWritten: 1,
      bytesTotal: 2,
      phase: "muxing",
    });
  });

  it("on complete: AWAITS the download then removes the job and emits job-complete", async () => {
    const d = deps();
    const r = createRouter(d);
    r.jobs.set(directDescriptor().id, {
      descriptor: directDescriptor(),
      choice: choice(),
      plan: { kind: "direct", url: "", filename: "" },
    });
    const out = await r.handleEngineMessage({
      type: "complete",
      streamId: directDescriptor().id,
      blobUrl: "blob:x",
      filename: "out.mp4",
      checksum: "abc",
    });
    expect(out?.type).toBe("job-complete");
    expect(d.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: "blob:x", filename: "out.mp4" }),
    );
    expect(r.jobs.size).toBe(0);
  });

  it("on complete: a download failure becomes job-failed with native_sink_io_error (no false success)", async () => {
    const d = deps();
    d.downloads.download.mockRejectedValueOnce(new Error("ENOSPC: disk full"));
    const r = createRouter(d);
    r.jobs.set(directDescriptor().id, {
      descriptor: directDescriptor(),
      choice: choice(),
      plan: { kind: "direct", url: "", filename: "" },
    });
    const out = await r.handleEngineMessage({
      type: "complete",
      streamId: directDescriptor().id,
      blobUrl: "blob:x",
      filename: "out.mp4",
      checksum: "abc",
    });
    expect(out?.type).toBe("job-failed");
    if (out?.type === "job-failed") {
      expect(out.error.code).toBe("native_sink_io_error");
    }
  });

  it("on complete: a file:// blobUrl (native sink wrote the file directly) skips chrome.downloads", async () => {
    const d = deps();
    const r = createRouter(d);
    r.jobs.set(directDescriptor().id, {
      descriptor: directDescriptor(),
      choice: choice(),
      plan: { kind: "direct", url: "", filename: "" },
    });
    const out = await r.handleEngineMessage({
      type: "complete",
      streamId: directDescriptor().id,
      blobUrl: "file:///Users/x/Downloads/out.mp4",
      filename: "out.mp4",
      checksum: "abc",
    });
    expect(out?.type).toBe("job-complete");
    expect(d.downloads.download).not.toHaveBeenCalled();
  });

  it("on failed: removes the job + emits job-failed", async () => {
    const r = createRouter(deps());
    r.jobs.set(directDescriptor().id, {
      descriptor: directDescriptor(),
      choice: choice(),
      plan: { kind: "direct", url: "", filename: "" },
    });
    const out = await r.handleEngineMessage({
      type: "failed",
      streamId: directDescriptor().id,
      error: { code: "engine_oom", severity: "terminal", workerMemoryMb: 100, budgetMb: 64 },
    });
    expect(out?.type).toBe("job-failed");
    expect(r.jobs.size).toBe(0);
  });
});

describe("router — popup message dispatch", () => {
  it("'list' returns the descriptors response", async () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    const out = await r.handlePopupMessage({ type: "list", tabId: 1 });
    expect(out).toEqual({
      type: "descriptors",
      tabId: 1,
      descriptors: [directDescriptor()],
    });
  });

  it("'cancel' removes the job and notifies the engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    const id = directDescriptor().id;
    r.jobs.set(id, {
      descriptor: directDescriptor(),
      choice: choice(),
      plan: { kind: "direct", url: "", filename: "" },
    });
    const out = await r.handlePopupMessage({ type: "cancel", streamId: id });
    expect(out).toEqual({ ok: true });
    expect(r.jobs.size).toBe(0);
    const sent = vi.mocked(d.runtime.sendMessage).mock.calls[0]?.[0];
    expect(sent).toEqual({ type: "cancel-job", streamId: id });
  });
});

describe("drmRefusalToError", () => {
  it("populates encrypted_media_detected with detectedVia from the descriptor", () => {
    const d = drmDescriptor("encrypted_media_detected");
    const err = drmRefusalToError("encrypted_media_detected", d);
    if (err.code !== "encrypted_media_detected") throw new Error("wrong code");
    expect(err.detectedVia).toContain("dash-content-protection");
  });

  it("falls back to 'unknown' keySystem when descriptor lacks it", () => {
    const d = { ...drmDescriptor("cdm_required"), drm: null };
    const err = drmRefusalToError("cdm_required", d);
    if (err.code !== "cdm_required") throw new Error("wrong code");
    expect(err.keySystem).toBe("unknown");
  });
});

function hlsMediaDescriptor(manifestUrl: string): StreamDescriptor {
  return hlsDescriptor({
    id: "stream-hls-media" as StreamId,
    source: { kind: "hls-manifest", manifestUrl, type: "media" },
    variants: [{
      ...hlsDescriptor().variants[0]!,
      id: `${manifestUrl}#media` as VariantId,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: manifestUrl,
        initSegmentUrl: null,
        segmentUrls: [`${manifestUrl}/seg0.ts`],
        encryption: null,
      },
    }],
  });
}
