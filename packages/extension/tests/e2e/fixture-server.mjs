#!/usr/bin/env node
/**
 * Minimal HTTP fixture server for Playwright e2e tests.
 *
 * Serves:
 *   /direct/clip.mp4 .webm .mkv  — small synthetic progressive files
 *   /hls/master.m3u8 + media.m3u8 + segNNN.ts — clear HLS VOD
 *   /hls-fmp4/master.m3u8 + media.m3u8 + EXT-X-MAP init + moof fragments
 *   /hls-aes/key + master + media + ciphertext segments
 *   /dash/clip.mpd + init.m4s + segNNN.m4s — clear DASH VOD
 *   /drm/widevine.mpd                       — DASH with Widevine ContentProtection
 *   /drm/clearkey.mpd                       — DASH with ClearKey (deferred reason)
 *   /low/clip.mp4                            — sub-720p video
 *   /negative/page.html, /negative/asset.{jpg,html,css,js,gif,png}
 *   /page/<scenario>.html                    — fixture HTML that links to the right asset
 *
 * Bytes are tiny and deliberately not playable media; classification only
 * looks at URL, headers, and the first 4 KB.
 */
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.env.SAVEMEDIA_FIXTURE_PORT ?? 0) || 5174;

const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.alloc(24, 0),
]);
const WEBM_HEADER = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00]);
const MKV_HEADER = WEBM_HEADER;

const MASTER_M3U8 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
media.m3u8
`;

const MEDIA_M3U8 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.0,
seg000.ts
#EXTINF:6.0,
seg001.ts
#EXT-X-ENDLIST
`;

const FMP4_MASTER_M3U8 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="av01.0.05M.08,mp4a.40.2"
media.m3u8
`;

const FMP4_MEDIA_M3U8 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init-v1-a1.mp4"
#EXTINF:6.0,
seg-1-v1-a1.mp4
#EXTINF:6.0,
seg-2-v1-a1.mp4
#EXT-X-ENDLIST
`;

const AES_MEDIA_M3U8 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6.0,
seg000.ts
#EXTINF:6.0,
seg001.ts
#EXT-X-ENDLIST
`;

const DASH_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>./</BaseURL>
        <SegmentList duration="6000" timescale="1000">
          <Initialization sourceURL="init.m4s"/>
          <SegmentURL media="seg000.m4s"/>
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

function aesEncrypt(plaintext) {
  const key = Buffer.alloc(16, 0xA5);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function html(scenario, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>${scenario}</title></head><body>${body}</body></html>`;
}

const routes = {
  // Direct files
  "/direct/clip.mp4":  { type: "video/mp4",      body: MP4_HEADER },
  "/direct/clip.webm": { type: "video/webm",     body: WEBM_HEADER },
  "/direct/clip.mkv":  { type: "video/x-matroska", body: MKV_HEADER },
  "/low/clip.mp4":     { type: "video/mp4",      body: MP4_HEADER },

  // HLS clear
  "/hls/master.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(MASTER_M3U8) },
  "/hls/media.m3u8":   { type: "application/vnd.apple.mpegurl", body: Buffer.from(MEDIA_M3U8) },
  "/hls/seg000.ts":    { type: "video/mp2t", body: Buffer.alloc(188, 0x47) },
  "/hls/seg001.ts":    { type: "video/mp2t", body: Buffer.alloc(188, 0x47) },

  // HLS fMP4. Bytes are shape-only for classification/capture filtering.
  "/hls-fmp4/master.m3u8":       { type: "application/vnd.apple.mpegurl", body: Buffer.from(FMP4_MASTER_M3U8) },
  "/hls-fmp4/media.m3u8":        { type: "application/vnd.apple.mpegurl", body: Buffer.from(FMP4_MEDIA_M3U8) },
  "/hls-fmp4/init-v1-a1.mp4":    { type: "video/mp4", body: MP4_HEADER },
  "/hls-fmp4/seg-1-v1-a1.mp4":   { type: "video/mp4", body: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x08]), Buffer.from("moof")]) },
  "/hls-fmp4/seg-2-v1-a1.mp4":   { type: "video/mp4", body: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x08]), Buffer.from("moof")]) },

  // HLS AES-128
  "/hls-aes/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(MASTER_M3U8.replace("media.m3u8", "media.m3u8")) },
  "/hls-aes/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(AES_MEDIA_M3U8) },
  "/hls-aes/key.bin":     { type: "application/octet-stream", body: Buffer.alloc(16, 0xA5) },
  "/hls-aes/seg000.ts":   { type: "video/mp2t", body: aesEncrypt(Buffer.alloc(64, 0x42)) },
  "/hls-aes/seg001.ts":   { type: "video/mp2t", body: aesEncrypt(Buffer.alloc(64, 0x43)) },

  // DASH
  "/dash/clip.mpd":     { type: "application/dash+xml", body: Buffer.from(DASH_MPD) },
  "/dash/init.m4s":     { type: "video/mp4", body: MP4_HEADER },
  "/dash/seg000.m4s":   { type: "video/mp4", body: Buffer.alloc(64, 0x01) },
  "/dash/seg001.m4s":   { type: "video/mp4", body: Buffer.alloc(64, 0x02) },

  // DRM
  "/drm/widevine.mpd":  { type: "application/dash+xml", body: Buffer.from(WIDEVINE_MPD) },
  "/drm/clearkey.mpd":  { type: "application/dash+xml", body: Buffer.from(CLEARKEY_MPD) },

  // Negative
  "/negative/page.html":  { type: "text/html",        body: Buffer.from("<p>hi</p>") },
  "/negative/asset.jpg":  { type: "image/jpeg",       body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.png":  { type: "image/png",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.gif":  { type: "image/gif",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.css":  { type: "text/css",         body: Buffer.from("body { color: red; }") },
  "/negative/asset.js":   { type: "application/javascript", body: Buffer.from("// noop") },
};

const pages = {
  direct: html("direct", `<video src="/direct/clip.mp4" controls width="640"></video>`),
  hls: html("hls", `<script>fetch("/hls/master.m3u8");</script><p>hls fixture</p>`),
  "hls-fmp4": html("hls-fmp4", `<script>
    fetch("/hls-fmp4/master.m3u8");
    fetch("/hls-fmp4/init-v1-a1.mp4").catch(() => {});
    fetch("/hls-fmp4/seg-1-v1-a1.mp4").catch(() => {});
  </script><p>hls fmp4 fixture</p>`),
  "embedded-hls": html("embedded-hls", `<script>
    window.__savemediaFixture = {"stream":{"url":"\\/hls\\/master.m3u8","urls":{"1080p":"\\/hls-fmp4\\/master.m3u8"}}};
  </script><p>embedded hls fixture</p>`),
  "hls-aes": html("hls-aes", `<script>fetch("/hls-aes/master.m3u8");</script><p>hls-aes fixture</p>`),
  dash: html("dash", `<script>fetch("/dash/clip.mpd");</script><p>dash fixture</p>`),
  widevine: html("widevine", `<script>fetch("/drm/widevine.mpd");</script><p>widevine fixture</p>`),
  clearkey: html("clearkey", `<script>fetch("/drm/clearkey.mpd");</script><p>clearkey fixture</p>`),
  negative: html("negative", `<img src="/negative/asset.jpg"><link rel="stylesheet" href="/negative/asset.css"><script src="/negative/asset.js"></script>`),
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
