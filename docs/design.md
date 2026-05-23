# savemedia Design

This document describes the repository's single supported product contract. It
does not split behavior into roadmap buckets: a path is supported, unsupported,
or not verified.

## Product Boundary

savemedia saves browser-visible video streams when the browser extension can
fetch every required byte and produce a playable output with tested code.

It refuses instead of guessing when any of these are true:

- the stream is protected by DRM or ClearKey/CENC sample encryption;
- the server denies access, rate-limits, or is busy after retries;
- a required manifest, key, init segment, or media segment cannot be fetched;
- the output would exceed the browser in-memory Blob limit;
- the requested conversion/remux path does not have a golden media test.

The extension must not save `.jpg`, `.jpeg`, `.png`, `.gif`, `.css`, `.js`,
`.html`, random segments, or mislabeled files as video downloads.

## Supported Capabilities

| Capability | Status | Verification |
| --- | --- | --- |
| Direct `.mp4` download | Works | Chrome e2e downloads real fixture and verifies with `ffprobe`. |
| Direct `.webm` / `.mkv` detection | Works | Fixture server and classification tests cover descriptors. |
| HLS MPEG-TS playlist download | Works | Chrome e2e remuxes real TS fixture to playable MP4. |
| HLS AES-128 with reachable key | Works | Chrome e2e decrypts real AES-CBC fixture and verifies MP4. |
| HLS fMP4/CMAF detection | Works | Chrome e2e verifies init/fragment URLs are not surfaced as standalone downloads. |
| DASH fMP4 SegmentList download | Works for tested single-video path | Chrome e2e downloads real init+media fixture and verifies MP4. |
| DRM detection | Works | Widevine fixture is refused with `cdm_required`. |
| ClearKey/CENC detection | Works | ClearKey fixture is refused; decryption is not implemented. |
| `Alt+S` best download command | Registered and manually tested in Chrome | Automated test checks command registration; headed Playwright does not fire extension shortcuts reliably. |
| Edge runtime | Not verified | Chromium zip is built, but no Edge smoke test exists. |
| Firefox runtime | Not verified | Firefox zip is built; Playwright project currently covers fixture pages only. |

## Unsupported

- Native messaging host, yt-dlp integration, ffmpeg integration, or >2 GiB
  streaming sink.
- ffmpeg.wasm or browser-side transcoding.
- "Small file", "best quality transcode", or arbitrary MP4 conversion modes.
- ClearKey/CENC sample decryption.
- Browser store submission assets or store compliance review.
- Mobile browser support.
- Side panel UI, subtitles, telemetry, cross-device sync.

## Runtime Architecture

```
Page MAIN world
  content-main.js
  resource timing, media-element, MediaSource, and EME observation only
        |
        v
Page ISOLATED world
  content-bridge.js
  validates __savemedia messages and calls chrome.runtime.sendMessage
        |
        v
Background router
  classifies descriptors, dedupes noisy segment URLs, owns job state
        |
        +-- direct progressive URL -> chrome.downloads.download
        |
        v
Chromium offscreen document
  engine host runs HLS/DASH jobs and returns Blob URLs
        |
        v
chrome.downloads.download
```

Firefox has a separate build target, but the extension runtime path is not
currently proven by e2e. Chrome passing is not Firefox evidence.

## Classification Rules

Classification is layered:

1. URL hints identify plausible media entry points.
2. HTTP headers refine container/content type.
3. HLS/DASH manifest parsing confirms protocols, variants, and DRM signals.
4. MP4 init/header probing refines codecs where needed.

The detector intentionally drops noisy internal pieces:

- HLS/DASH segment URLs (`.ts`, `.m4s`, numbered fragments);
- fMP4 init segments such as `init.mp4`;
- non-media web assets;
- repeated numeric direct-fragment families that are not a complete video.

## Download Jobs

### Direct

Direct progressive files are handed to `chrome.downloads.download`. The
extension does not convert progressive containers. If the server provides MKV,
the saved file is MKV.

### HLS

The engine fetches the selected media playlist, not just the master playlist.
Runtime playlist parsing is authoritative for encryption because `EXT-X-KEY`
usually lives on the media playlist.

Supported:

- clear MPEG-TS HLS -> MP4 remux;
- clear fMP4/CMAF HLS with `EXT-X-MAP`;
- HLS AES-128 whole-segment encryption with a reachable key URI.

Unsupported:

- SAMPLE-AES / SAMPLE-AES-CTR;
- missing AES-128 key URI;
- missing fMP4 init map.

### DASH

The tested path is one video representation with an init segment and fMP4 media
segments. MPD segment URLs are resolved through `mpd-parser`'s `resolvedUri`
fields so relative `SegmentList` entries fetch from the manifest origin.

Separate audio/video adaptation merging and more exotic MPD layouts are
unsupported unless a deterministic golden fixture proves them.

## Failure Reasons

User-visible failures are categorized before surfacing:

- `rate_limited`: HTTP 429, includes `Retry-After` when present.
- `server_busy`: HTTP 408, 425, or 5xx after retries.
- `access_denied`: HTTP 401, 402, or 403. This covers login, entitlement,
  payment, expired signed URL, or site-side block. It is not called DRM unless
  an actual DRM signal was detected.
- `network_unreachable`: browser fetch failed before an HTTP response.
- `output_too_large_for_browser`: estimated output exceeds the browser Blob
  path limit.
- `browser_download_failed`: Chrome/Firefox refused the final save.
- DRM/ClearKey codes: terminal, no retry action.

Partial stream outputs are aborted and discarded on required-segment failure.

## Verification Strategy

The project treats downloader correctness as a media problem, not a "file was
created" problem.

- Unit tests cover classification, dispatch, retry classification, routing,
  popup error rendering, HLS/DASH runners, and parser edge cases.
- E2E fixture server serves real tiny media generated by ffmpeg.
- Chromium e2e loads the unpacked extension, triggers real downloads, and runs
  `ffprobe` on the resulting files.
- Firefox e2e currently exercises the fixture server without loading the
  extension. This is intentionally documented as a gap.

Any advertised protocol/container path needs a golden fixture plus a
playback/`ffprobe` assertion.
