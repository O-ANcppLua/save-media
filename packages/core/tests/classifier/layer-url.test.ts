import { describe, expect, it } from "vitest";
import { classifyByUrl } from "../../src/classifier/layer-url";

describe("layer-url", () => {
  it("foo.m3u8 → protocol=hls (guessed)", () => {
    const r = classifyByUrl("https://cdn.example.com/foo.m3u8?token=abc");
    expect(r.protocol).toBe("hls");
    expect(r.confidence.protocol).toBe("guessed");
  });

  it("foo.mpd → protocol=dash", () => {
    expect(classifyByUrl("https://cdn/x/foo.mpd").protocol).toBe("dash");
  });

  it("foo.mp4 → container=mp4", () => {
    const r = classifyByUrl("https://cdn/v.mp4");
    expect(r.container).toBe("mp4");
    expect(r.confidence.container).toBe("guessed");
  });

  it("old direct containers are not accepted from URL hints", () => {
    expect(classifyByUrl("https://cdn/v.mov").container).toBe("unknown");
    expect(classifyByUrl("https://cdn/v.avi").container).toBe("unknown");
    expect(classifyByUrl("https://cdn/v.flv").container).toBe("unknown");
  });

  it("unknown URL → no signals", () => {
    const r = classifyByUrl("https://example.com/abc");
    expect(r.protocol).toBe("unknown");
    expect(r.container).toBe("unknown");
  });

  it("ignores hashes and query params for extension matching", () => {
    expect(classifyByUrl("https://x/v.mp4#t=10").container).toBe("mp4");
  });
});
