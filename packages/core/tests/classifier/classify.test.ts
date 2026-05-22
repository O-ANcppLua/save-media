import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../../src/classifier/classify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, `../fixtures/${n}`), "utf-8");

describe("classify orchestration", () => {
  it("progressive MP4: url+headers+bytes → mp4 confirmed", async () => {
    const ftyp = new Uint8Array(16);
    ftyp.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]);
    ftyp.set(new TextEncoder().encode("isom"), 8);

    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn.example.com/v.mp4",
      headers: { "content-type": "video/mp4" },
      bodyBytes: ftyp,
      manifestText: null,
    });

    expect(d.protocol).toBe("progressive-http");
    expect(d.container).toBe("mp4");
    expect(d.confidence.container).toBe("confirmed");
    expect(d.drm).toBeNull();
    expect(d.capabilities.directDownload).toBe(true);
  });

  it("HLS master playlist → variants populated", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/master.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: fx("hls/master-vod-h264-aac.m3u8"),
    });
    expect(d.protocol).toBe("hls");
    expect(d.variants.length).toBe(3);
    expect(d.drm).toBeNull();
  });

  it("HLS media playlist → single downloadable variant for the playlist itself", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/video/1080p.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:4.0,
seg-1.ts
#EXTINF:4.0,
seg-2.ts
#EXT-X-ENDLIST
`,
    });

    expect(d.protocol).toBe("hls");
    expect(d.source).toMatchObject({
      kind: "hls-manifest",
      manifestUrl: "https://cdn/video/1080p.m3u8",
      type: "media",
    });
    expect(d.container).toBe("mpegts");
    expect(d.variants).toHaveLength(1);
    expect(d.variants[0]?.segmentRef).toMatchObject({
      kind: "hls-segments",
      playlistUrl: "https://cdn/video/1080p.m3u8",
      segmentUrls: [
        "https://cdn/video/seg-1.ts",
        "https://cdn/video/seg-2.ts",
      ],
      encryption: null,
    });
  });

  it("DASH MPD with Widevine → drmBlocked", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/m.mpd",
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: fx("dash/mpd-widevine-drm.mpd"),
    });
    expect(d.protocol).toBe("dash");
    expect(d.drm?.reason).toBe("cdm_required");
    expect(d.capabilities.drmBlocked).toBe(true);
  });

  it("DASH MPD with ClearKey → clearkey_deferred + drmBlocked", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/m.mpd",
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: fx("dash/mpd-clearkey-deferred.mpd"),
    });
    expect(d.drm?.reason).toBe("clearkey_deferred");
    expect(d.capabilities.drmBlocked).toBe(true);
  });
});
