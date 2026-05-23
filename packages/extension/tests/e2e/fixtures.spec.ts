import { test, expect } from "@playwright/test";

/**
 * Smoke-level e2e: load each fixture page and assert the fixture server
 * served the expected media payload. The full extension-under-load tests
 * (popup detection counts, click → download, DRM refusal cards) require
 * the extension to be present and the build artifact to be loaded —
 * those run in the chromium project where launchOptions injects the
 * unpacked extension. CI must skip them when the extension build is
 * missing.
 */

test.describe("fixture server", () => {
  test("serves the direct MP4 fixture page", async ({ page }) => {
    await page.goto("/page/direct.html");
    const src = await page.locator("video").getAttribute("src");
    expect(src).toBe("/direct/clip.mp4");
    const response = await page.request.get("/direct/clip.mp4");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("video/mp4");
  });

  test("serves the HLS master + media playlists", async ({ page }) => {
    await page.goto("/page/hls.html");
    const master = await page.request.get("/hls/master.m3u8");
    expect(master.status()).toBe(200);
    const masterText = await master.text();
    expect(masterText).toContain("EXT-X-STREAM-INF");
    expect(masterText).toContain("media.m3u8");
    const media = await page.request.get("/hls/media.m3u8");
    const mediaText = await media.text();
    expect(mediaText).toContain("seg000.ts");
    expect(mediaText).toContain("EXT-X-ENDLIST");
  });

  test("serves the HLS live fixture without EXT-X-ENDLIST", async ({ page }) => {
    await page.goto("/page/hls-live.html");
    const media = await page.request.get("/hls-live/media.m3u8");
    const mediaText = await media.text();
    expect(mediaText).toContain("seg000.ts");
    expect(mediaText).not.toContain("EXT-X-ENDLIST");
  });

  test("serves the HLS fMP4 playlist with EXT-X-MAP init segment", async ({ page }) => {
    await page.goto("/page/hls-fmp4.html");
    const media = await page.request.get("/hls-fmp4/media.m3u8");
    const text = await media.text();
    expect(text).toContain("EXT-X-MAP");
    expect(text).toContain("init.mp4");
    expect(text).toContain("seg000.m4s");
  });

  test("serves the HLS AES-128 fixture with a reachable 16-byte key", async ({ page }) => {
    await page.goto("/page/hls-aes.html");
    const playlist = await page.request.get("/hls-aes/media.m3u8");
    expect(await playlist.text()).toContain("METHOD=AES-128");
    const key = await page.request.get("/hls-aes/key.bin");
    expect(Number(key.headers()["content-length"])).toBe(16);
  });

  test("serves a clear DASH MPD for detection/refusal", async ({ page }) => {
    await page.goto("/page/dash.html");
    const mpd = await page.request.get("/dash/clip.mpd");
    const text = await mpd.text();
    expect(text).toContain("SegmentList");
    expect(text).toContain("init.m4s");
    expect((await page.request.get("/dash/init.m4s")).status()).toBe(404);
  });

  test("widevine MPD has the Widevine UUID in ContentProtection", async ({ page }) => {
    await page.goto("/page/widevine.html");
    const mpd = await page.request.get("/drm/widevine.mpd");
    expect(await mpd.text()).toContain("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");
  });

  test("clearkey MPD uses the DASH-IF ClearKey UUID", async ({ page }) => {
    await page.goto("/page/clearkey.html");
    const mpd = await page.request.get("/drm/clearkey.mpd");
    expect(await mpd.text()).toContain("e2719d58-a985-b3c9-781a-b030af78d30e");
  });

  test("negative page returns non-media assets that classification must ignore", async ({ page }) => {
    await page.goto("/page/negative.html");
    for (const path of [
      "/negative/asset.jpg",
      "/negative/asset.jpeg",
      "/negative/asset.png",
      "/negative/page.html",
      "/negative/asset.css",
      "/negative/asset.js",
      "/negative/asset.gif",
      "/negative/asset.mp3",
      "/negative/asset.m4a",
    ]) {
      const r = await page.request.get(path);
      expect(r.status()).toBe(200);
      const ct = r.headers()["content-type"] ?? "";
      expect(ct).not.toContain("video");
      expect(ct).not.toContain("mpegurl");
    }
  });

  test("low fixture page exposes a sub-720p direct video", async ({ page }) => {
    await page.goto("/page/low.html");
    const r = await page.request.get("/low/clip.mp4");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("video/mp4");
  });
});
