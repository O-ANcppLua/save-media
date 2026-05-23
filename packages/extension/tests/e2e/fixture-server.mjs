#!/usr/bin/env node
/**
 * Minimal HTTP fixture server for Playwright e2e tests.
 *
 * Serves:
 *   /direct/clip.mp4 .webm .mkv  — tiny real progressive files
 *   /hls/master.m3u8 + media.m3u8 + segNNN.ts — real clear HLS VOD
 *   /hls-fmp4/master.m3u8 + media.m3u8 + EXT-X-MAP init + m4s fragments — refused layout
 *   /hls-aes/key + master + media + ciphertext segments — refused encryption
 *   /dash/clip.mpd                         — clear DASH descriptor, refused download
 *   /drm/widevine.mpd                      — DASH with Widevine ContentProtection
 *   /drm/clearkey.mpd                      — DASH with ClearKey refusal
 *   /low/clip.mp4                            — sub-720p video
 *   /negative/page.html, /negative/asset.{jpg,html,css,js,gif,png,mp3,m4a}
 *   /page/<scenario>.html                    — fixture HTML that links to the right asset
 *
 * Downloadable media bytes are intentionally tiny, but they are real
 * ffmpeg-generated containers so download e2e can verify playable output.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.SAVEMEDIA_FIXTURE_PORT ?? 0) || 5174;
const here = dirname(fileURLToPath(import.meta.url));
const mediaRoot = join(here, "media-fixtures");

const DASH_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>video/</BaseURL>
        <SegmentList timescale="1" duration="4">
          <Initialization sourceURL="init.m4s"/>
          <SegmentURL media="seg001.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const WIDEVINE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const CLEARKEY_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>`;

function html(scenario, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>${scenario}</title></head><body>${body}</body></html>`;
}

function fixture(rel) {
  return readFileSync(join(mediaRoot, rel));
}

const routes = {
  // Direct files
  "/direct/clip.mp4":  { type: "video/mp4", body: fixture("direct/clip.mp4") },
  "/direct/clip.webm": { type: "video/webm", body: fixture("direct/clip.webm") },
  "/direct/clip.mkv":  { type: "video/x-matroska", body: fixture("direct/clip.mkv") },
  "/low/clip.mp4":     { type: "video/mp4", body: fixture("low/clip.mp4") },

  // HLS clear
  "/hls/master.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls/master.m3u8") },
  "/hls/media.m3u8":   { type: "application/vnd.apple.mpegurl", body: fixture("hls/media.m3u8") },
  "/hls/seg000.ts":    { type: "video/mp2t", body: fixture("hls/seg000.ts") },

  // HLS live/sliding-window refusal
  "/hls-live/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
media.m3u8
`) },
  "/hls-live/media.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:4.000,
seg000.ts
`) },
  "/hls-live/seg000.ts": { type: "video/mp2t", body: fixture("hls/seg000.ts") },

  // HLS fMP4
  "/hls-fmp4/master.m3u8": { type: "application/vnd.apple.mpegurl", body: fixture("hls-fmp4/master.m3u8") },
  "/hls-fmp4/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls-fmp4/media.m3u8") },
  "/hls-fmp4/init.mp4":    { type: "video/mp4", body: fixture("hls-fmp4/init.mp4") },
  "/hls-fmp4/seg000.m4s":  { type: "video/iso.segment", body: fixture("hls-fmp4/seg000.m4s") },

  // HLS AES-128
  "/hls-aes/master.m3u8": { type: "application/vnd.apple.mpegurl", body: fixture("hls-aes/master.m3u8") },
  "/hls-aes/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls-aes/media.m3u8") },
  "/hls-aes/key.bin":     { type: "application/octet-stream", body: fixture("hls-aes/key.bin") },
  "/hls-aes/seg000.ts":   { type: "video/mp2t", body: fixture("hls-aes/seg000.ts") },

  // DASH detection/refusal only. Segment bytes are intentionally not served.
  "/dash/clip.mpd":     { type: "application/dash+xml", body: Buffer.from(DASH_MPD) },

  // DRM
  "/drm/widevine.mpd":  { type: "application/dash+xml", body: Buffer.from(WIDEVINE_MPD) },
  "/drm/clearkey.mpd":  { type: "application/dash+xml", body: Buffer.from(CLEARKEY_MPD) },

  // Negative
  "/negative/page.html":  { type: "text/html",        body: Buffer.from("<p>hi</p>") },
  "/negative/asset.jpg":  { type: "image/jpeg",       body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.jpeg": { type: "image/jpeg",       body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.png":  { type: "image/png",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.gif":  { type: "image/gif",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.css":  { type: "text/css",         body: Buffer.from("body { color: red; }") },
  "/negative/asset.js":   { type: "application/javascript", body: Buffer.from("// noop") },
  "/negative/asset.mp3":  { type: "audio/mpeg",       body: Buffer.alloc(64, 0x00) },
  "/negative/asset.m4a":  { type: "audio/mp4",        body: Buffer.alloc(64, 0x00) },
};

const pages = {
  direct: html("direct", `<video src="/direct/clip.mp4" controls width="640"></video>`),
  hls: html("hls", `<script>fetch("/hls/master.m3u8");</script><p>hls fixture</p>`),
  "hls-live": html("hls-live", `<script>fetch("/hls-live/master.m3u8");</script><p>hls live fixture</p>`),
  "hls-fmp4": html("hls-fmp4", `<script>
    fetch("/hls-fmp4/master.m3u8");
    fetch("/hls-fmp4/init.mp4").catch(() => {});
    fetch("/hls-fmp4/seg000.m4s").catch(() => {});
  </script><p>hls fmp4 fixture</p>`),
  "embedded-hls": html("embedded-hls", `<script>
    window.__savemediaFixture = {"stream":{"url":"\\/hls\\/master.m3u8","urls":{"1080p":"\\/hls-fmp4\\/master.m3u8"}}};
  </script><p>embedded hls fixture</p>`),
  "hls-aes": html("hls-aes", `<script>fetch("/hls-aes/master.m3u8");</script><p>hls-aes fixture</p>`),
  dash: html("dash", `<script>fetch("/dash/clip.mpd");</script><p>dash fixture</p>`),
  widevine: html("widevine", `<script>fetch("/drm/widevine.mpd");</script><p>widevine fixture</p>`),
  clearkey: html("clearkey", `<script>fetch("/drm/clearkey.mpd");</script><p>clearkey fixture</p>`),
  negative: html("negative", `<img src="/negative/asset.jpg"><img src="/negative/asset.jpeg"><img src="/negative/asset.png"><iframe src="/negative/page.html"></iframe><link rel="stylesheet" href="/negative/asset.css"><script src="/negative/asset.js"></script><audio src="/negative/asset.mp3" controls></audio><a href="/negative/asset.m4a">audio</a>`),
  low: html("low", `<video src="/low/clip.mp4" controls></video>`),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/page/")) {
    const scenario = url.pathname.split("/")[2]?.replace(".html", "") ?? "";
    const body = pages[scenario];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }
  const route = routes[url.pathname];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": route.type,
    "Content-Length": String(route.body.length),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(route.body);
});

server.listen(port, () => {
  console.log(`[fixture-server] listening on http://localhost:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
