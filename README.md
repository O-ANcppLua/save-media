# savemedia

Browser extension for saving browser-visible video streams. The repository has
one support contract: direct files, tested HLS/DASH paths, and honest refusal
when the stream cannot be saved without broken output or unsupported
decryption.

This is not a DRM bypass tool. It does not use a native host, yt-dlp,
ffmpeg.wasm, or hidden remote services. Unsupported paths are unsupported; the
docs do not split them into roadmap buckets.

## Supported

Verified in the Chrome Playwright extension suite with real ffmpeg-generated
golden media fixtures:

- Direct progressive video: `.mp4`, `.webm`, `.mkv`
- HLS master/media playlists with MPEG-TS segments, saved as playable MP4
- HLS AES-128 when the playlist exposes a reachable key URI
- HLS fMP4/CMAF playlists with `EXT-X-MAP`
- DASH `SegmentList` fMP4 video with init + media segments, saved as playable MP4
- DRM and ClearKey/CENC detection with no Download button
- Negative filtering for `.jpg`, `.jpeg`, `.png`, `.gif`, `.css`, `.js`, `.html`
- `Alt+S` command registration in Chrome; manual Chrome testing confirmed it
  starts the highest-quality detected download on the current tab

The engine aborts and deletes partial in-memory output when a required segment
fails. It should not save random chunk files or mislabeled `.ts` files as video.

## Unsupported

- No DRM circumvention: Widevine, PlayReady, FairPlay, SAMPLE-AES, and encrypted
  EME paths are refused.
- ClearKey/CENC sample decryption is not implemented. It is detected separately
  from CDM-bound DRM, but it is not downloaded.
- No transcoding and no "make smaller" mode.
- No arbitrary progressive-container remux. Direct progressive files are saved
  as the server provides them.
- No native host and no >2 GiB streaming sink. Browser Blob limits are enforced
  before starting a risky in-browser save.
- DASH support is limited to the currently tested fMP4 init+media path. More
  complex DASH audio/video layouts need their own golden fixture before being
  advertised.

## Browser Verification

| Browser target | Current evidence | Claim level |
| --- | --- | --- |
| Chrome | Automated unpacked-extension Playwright suite, including golden downloadable media verified with `ffprobe`. | Supported for the capabilities listed above. |
| Edge | Builds from the same Chromium bundle and packages as `savemedia-edge-0.0.1.zip`. No independent Edge runtime smoke test is currently checked in. | Build exists; runtime parity is not claimed. |
| Firefox | Firefox bundle builds. CI/Playwright currently runs baseline fixture-server checks only; extension behavior is skipped because Firefox MV3 loading needs a separate `web-ext` harness. | Build exists; extension runtime is not verified yet. |

Browser store submission is outside the verified repository contract. Any store
listing must match the browser evidence above.

## Architecture

- `packages/core`: pure TypeScript classification, dispatch, verification,
  retry policy, and user-facing error taxonomy.
- `packages/extension`: MV3 extension, popup UI, background router, content
  detection, offscreen engine host, HLS/DASH runners, and package scripts.
- `packages/extension/tests/e2e/media-fixtures`: real tiny media fixtures used
  by Playwright and `ffprobe`; these are the source of truth for downloader
  correctness.

Chrome execution path:

1. MAIN-world content script detects visible media URLs and posts tagged
   messages.
2. ISOLATED bridge relays those messages to the service worker.
3. Service worker classifies descriptors, dedupes noisy segment URLs, and
   starts either a direct browser download or an engine job.
4. Offscreen engine fetches required manifests/segments, decrypts HLS AES-128
   when allowed, remuxes tested stream paths, verifies container output, and
   hands a Blob URL to `chrome.downloads.download`.

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
