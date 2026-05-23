import { describe, it, expect } from "vitest";
import { MAIN_BRIDGE_TAG } from "../../../src/types/messages";
import type {
  MainToBridgeMessage,
  BridgeToBackgroundMessage,
  BackgroundToContentMessage,
  ContentDiscoveryResponse,
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../../../src/types/messages";
import type { StreamId, VariantId } from "@savemedia/core";

describe("message types", () => {
  it("MAIN_BRIDGE_TAG is the agreed string discriminator", () => {
    expect(MAIN_BRIDGE_TAG).toBe("__savemedia");
  });

  it("MainToBridgeMessage carries the discriminator key set to true", () => {
    const msg: MainToBridgeMessage = {
      [MAIN_BRIDGE_TAG]: true,
      kind: "fetch",
      url: "https://x/clip.mp4",
      pageUrl: "https://x/",
    };
    expect(msg[MAIN_BRIDGE_TAG]).toBe(true);
    expect(msg.kind).toBe("fetch");
  });

  it("BridgeToBackgroundMessage 'capture' wraps a MainToBridgeMessage payload", () => {
    const wrap: BridgeToBackgroundMessage = {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "fetch",
        url: "https://x/clip.mp4",
        pageUrl: "https://x/",
      },
    };
    expect(wrap.type).toBe("capture");
    expect(wrap.payload[MAIN_BRIDGE_TAG]).toBe(true);
  });

  it("BackgroundToContentMessage asks the bridge to discover page media URLs", () => {
    const msg: BackgroundToContentMessage = { type: "discover-page-media" };
    const response: ContentDiscoveryResponse = {
      pageUrl: "https://example.com/watch",
      urls: ["https://cdn.example.com/master.m3u8"],
    };
    expect(msg.type).toBe("discover-page-media");
    expect(response.urls[0]).toContain("master.m3u8");
  });

  it("PopupToBackgroundMessage download carries streamId + choice", () => {
    const id = "stream-1" as StreamId;
    const variantId = "v1" as VariantId;
    const msg: PopupToBackgroundMessage = {
      type: "download",
      streamId: id,
      choice: {
        outputMode: "Original",
        filename: "clip.mp4",
        variantId,
        audioRenditionId: null,
      },
    };
    expect(msg.type).toBe("download");
    expect(msg.choice.filename).toBe("clip.mp4");
  });

  it("BackgroundToPopupMessage job-progress is well-typed", () => {
    const id = "stream-1" as StreamId;
    const msg: BackgroundToPopupMessage = {
      type: "job-progress",
      streamId: id,
      bytesWritten: 1024,
      bytesTotal: 4096,
      phase: "fetching",
    };
    expect(msg.bytesWritten).toBe(1024);
    expect(msg.bytesTotal).toBe(4096);
  });

  it("BackgroundToEngineMessage start-job + cancel-job are exhaustive", () => {
    const id = "stream-1" as StreamId;
    const start: BackgroundToEngineMessage = {
      type: "start-job",
      streamId: id,
      descriptor: {
        id,
        tabId: 1,
        pageUrl: "https://x/",
        title: "clip",
        detectedAt: 1,
        source: { kind: "direct-url", url: "https://x/clip.mp4", headers: {} },
        protocol: "progressive-http",
        container: "mp4",
        codecs: { video: null, audio: null, subtitles: [] },
        variants: [],
        drm: null,
        capabilities: { directDownload: true, remuxableTo: ["mp4"], transcodeableTo: ["mp4"], drmBlocked: false },
        confidence: { protocol: "guessed", container: "guessed", codecs: "guessed" },
      },
      choice: {
        outputMode: "Original",
        filename: "clip.mp4",
        variantId: null,
        audioRenditionId: null,
      },
    };
    const cancel: BackgroundToEngineMessage = { type: "cancel-job", streamId: id };
    expect(start.type).toBe("start-job");
    expect(cancel.type).toBe("cancel-job");
  });

  it("EngineToBackgroundMessage covers progress | complete | failed", () => {
    const id = "stream-1" as StreamId;
    const p: EngineToBackgroundMessage = {
      type: "progress",
      streamId: id,
      bytesWritten: 1,
      bytesTotal: 2,
      phase: "muxing",
    };
    const c: EngineToBackgroundMessage = {
      type: "complete",
      streamId: id,
      blobUrl: "blob:x",
      filename: "y.mp4",
      checksum: "abc",
    };
    const f: EngineToBackgroundMessage = {
      type: "failed",
      streamId: id,
      error: { code: "manifest_404", severity: "terminal", url: "", httpStatus: 404 },
    };
    expect(p.type).toBe("progress");
    expect(c.type).toBe("complete");
    expect(f.type).toBe("failed");
  });
});
