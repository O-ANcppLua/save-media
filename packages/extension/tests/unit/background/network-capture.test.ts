import { describe, expect, it } from "vitest";
import { looksLikeMediaEntryUrl } from "../../../src/background/network-capture";

describe("background network capture URL filter", () => {
  it("captures manifest and standalone media entry URLs", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/master.m3u8")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/manifest.mpd?token=1")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/movie.mp4#t=0", "media")).toBe(true);
  });

  it("does not capture HLS/DASH segment URLs as standalone downloads", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/seg-1.ts")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/chunk-1.m4s")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/init.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/720p.av1.mp4/init-v1-a1.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/720p.av1.mp4/seg-22-v1-a1.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/movie.mp4", "xmlhttprequest")).toBe(false);
  });

  it("does not capture standalone audio files as video entries", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/track.mp3")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/track.m4a")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/segment-01.aac")).toBe(false);
  });
});
