import { describe, expect, it, vi } from "vitest";
import {
  discoverPageMediaForTab,
  downloadBestForActiveTab,
  registerDownloadBestCommand,
  type DownloadBestDeps,
} from "../../../src/background/download-best";
import { MAIN_BRIDGE_TAG, type ContentDiscoveryResponse } from "../../../src/types/messages";
import { directDescriptor } from "../popup/helpers/descriptors";

function deps(overrides: Partial<DownloadBestDeps> = {}): DownloadBestDeps {
  const base: DownloadBestDeps = {
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
      sendMessage: vi.fn((_tabId, _msg, cb) => cb({
        pageUrl: "https://example.com/watch",
        urls: ["https://cdn.example.com/master.m3u8"],
      })),
    },
    runtime: {
      lastError: vi.fn(() => null),
      sendMessage: vi.fn(),
    },
    router: {
      startBestDownload: vi.fn(async () => null),
    },
    handleCapture: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides };
}

describe("download-best command helpers", () => {
  it("asks the content bridge for embedded URLs and replays them as capture messages", async () => {
    const d = deps();

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    expect(d.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      { type: "discover-page-media" },
      expect.any(Function),
    );
    expect(d.handleCapture).toHaveBeenCalledWith(42, {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "media-source",
        url: "https://cdn.example.com/master.m3u8",
        pageUrl: "https://example.com/watch",
      },
    });
  });

  it("uses the tab URL when the bridge response has no page URL", async () => {
    const d = deps({
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
        sendMessage: vi.fn((_tabId, _msg, cb) => cb({
          pageUrl: "",
          urls: ["https://cdn.example.com/master.m3u8"],
        })),
      },
    });

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    const msg = vi.mocked(d.handleCapture).mock.calls[0]?.[1];
    expect(msg?.payload.pageUrl).toBe("https://fallback.example/");
  });

  it("ignores tabs where no bridge is available", async () => {
    const d = deps({
      runtime: {
        lastError: vi.fn(() => ({ message: "receiving end does not exist" })),
        sendMessage: vi.fn(),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
        sendMessage: vi.fn((_tabId, _msg, cb) => cb(undefined as ContentDiscoveryResponse | undefined)),
      },
    });

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    expect(d.handleCapture).not.toHaveBeenCalled();
  });

  it("runs discovery before starting the best tab download", async () => {
    const d = deps();

    await downloadBestForActiveTab(d);

    expect(d.handleCapture).toHaveBeenCalledTimes(1);
    expect(d.router.startBestDownload).toHaveBeenCalledWith(42);
  });

  it("forwards startBestDownload failures to popup listeners", async () => {
    const descriptor = directDescriptor();
    const error = { code: "native_sink_io_error", severity: "terminal", errno: "ENOSPC", path: "clip.mp4" } as const;
    const d = deps({
      router: {
        startBestDownload: vi.fn(async () => ({
          streamId: descriptor.id,
          error,
        })),
      },
    });

    await downloadBestForActiveTab(d);

    expect(d.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "job-failed",
        streamId: descriptor.id,
        error,
      },
      expect.any(Function),
    );
  });

  it("registers only the download-best command name", () => {
    let listener: (command: string) => void = () => undefined;
    const d = deps();
    registerDownloadBestCommand({ onCommand: { addListener: fn => { listener = fn; } } }, d);

    listener("other-command");
    expect(d.tabs.query).not.toHaveBeenCalled();

    listener("download-best");
    expect(d.tabs.query).toHaveBeenCalledTimes(1);
  });
});
