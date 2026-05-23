# savemedia

Browser extension for saving browser-visible video when the extension can prove
it is a complete video and can produce one playable final file.

There is one support contract. A path is either supported, refused with a clear
reason, or not claimed. savemedia is not a DRM bypass tool and does not use a
native host, yt-dlp, ffmpeg.wasm, local ffmpeg, or hidden remote services.

## Supported

Verified in the Chrome Playwright extension suite with real media fixtures:

- Direct progressive `.mp4`, `.webm`, and `.mkv` files after headers or magic
  bytes confirm the container. A matching URL extension alone is only a hint.
- Plain HLS VOD with MPEG-TS segments, remuxed to one playable MP4.
- DRM, ClearKey/CENC, DASH, encrypted HLS, HLS fMP4/CMAF, and live HLS detection
  as refusal cases.
- Negative filtering for `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.css`,
  `.js`, `.html`, standalone audio files, orphan `.ts`, orphan `.m4s`, init
  segments, and numbered chunk URLs.
- `Alt+S` command registration in Chrome. Manual Chrome testing confirmed it
  starts the highest-quality supported detected download on the current tab.

The engine aborts partial in-memory output when a required segment fails. It
must not save random chunks, fake `.mp4` HTML responses, or mislabeled `.ts`
bytes as final video.

## Refused

- DASH downloads.
- Standalone audio downloads.
- HLS AES-128, SAMPLE-AES, SAMPLE-AES-CTR, ClearKey/CENC, Widevine, PlayReady,
  FairPlay, and other protected media paths.
- HLS Live/DVR or any playlist without `EXT-X-ENDLIST`.
- HLS fMP4/CMAF layouts until structural validation is implemented and covered
  by golden media tests.
- Direct `.mov`, `.avi`, `.wmv`, `.flv`, `.m4v` as independent support claims.
  `m4v` may be accepted only when bytes prove it is normal MP4.
- Transcoding, size-reduction modes, arbitrary container conversion, and
  browser-native downloads above the in-memory safety limit.
- Unknown protocol or URL-only "best effort" downloads.

## Browser Evidence

| Browser target | Current evidence | Claim level |
| --- | --- | --- |
| Chrome | Automated unpacked-extension Playwright suite, including real downloads verified with `ffprobe`. | Supported for the capabilities above. |
| Edge | Chromium zip is built as `savemedia-edge-0.0.1.zip`; no independent Edge runtime smoke test is checked in. | Build exists; runtime parity is not claimed. |
| Firefox | Firefox zip builds. CI/Playwright currently exercises fixture pages only; extension behavior is skipped until a Firefox MV3/web-ext harness exists. | Build exists; extension runtime is not claimed. |

Browser store submission is outside the verified repository contract. Any store
listing must match the browser evidence above.

## Architecture

- `packages/core`: classification, DASH/DRM/HLS parsing for descriptors,
  dispatch decisions, retry policy, and user-facing error taxonomy.
- `packages/extension`: MV3 extension, popup UI, background router, passive
  content detection, Chromium offscreen engine host, direct downloads, and
  plain-HLS jobs.
- `packages/extension/tests/e2e/media-fixtures`: real tiny downloadable media
  fixtures used by Playwright and `ffprobe`.

Chrome execution path:

1. MAIN-world content script passively observes resource timing, media elements,
   MediaSource encryption probes, and EME requests. It does not monkey-patch
   page `fetch` or `XMLHttpRequest`.
2. ISOLATED bridge relays tagged messages to the service worker.
3. The service worker also watches network entry requests, classifies
   descriptors, dedupes noisy segment URLs, and starts either a direct browser
   download or an HLS engine job.
4. The offscreen engine fetches the selected HLS media playlist and segments,
   refuses unsupported layouts/encryption, remuxes MPEG-TS to MP4, verifies the
   MP4 signature, and hands a Blob URL to `chrome.downloads.download`.

## Development

```sh
pnpm install
pnpm --filter @savemedia/core build
pnpm -r typecheck
pnpm -r test
pnpm --filter @savemedia/extension build:chrome
pnpm --filter @savemedia/extension exec playwright test --project=chromium
pnpm --filter @savemedia/extension zip
```

`pnpm verify` runs the type/unit/build gate. The Chromium Playwright suite is
kept separate because it launches a headed browser with the unpacked extension.
Install `ffmpeg`/`ffprobe` before running the Chromium e2e media-download tests.

## Loading Locally

Build and load Chrome from:

```sh
pnpm --filter @savemedia/extension build:chrome
```

Then load `packages/extension/dist-chrome` as an unpacked extension.

Release zips are created by:

```sh
pnpm --filter @savemedia/extension zip
```
