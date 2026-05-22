import { describe, expect, it } from "vitest";
import { looksLikeMediaEntryUrl } from "../../../src/background/network-capture";

describe("background network capture URL filter", () => {
  it("captures manifest and standalone media entry URLs", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/master.m3u8")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/manifest.mpd?token=1")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/movie.mp4#t=0")).toBe(true);
  });

  it("does not capture HLS/DASH segment URLs as standalone downloads", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/seg-1.ts")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/chunk-1.m4s")).toBe(false);
  });
});
