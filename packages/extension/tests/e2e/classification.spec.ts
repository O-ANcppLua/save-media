import { test, expect, chromium, type BrowserContext, type Worker as PlaywrightWorker } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "..", "dist-chrome");
const hasExtension = existsSync(dist) && existsSync(resolve(dist, "background.js"));

/**
 * End-to-end classification: load the unpacked Chrome extension into a
 * persistent context, visit each fixture page, and verify the background
 * service worker classified the captured media correctly.
 *
 * **Reading SW state from tests.** `chrome.runtime.sendMessage` called
 * from the SW itself is NOT delivered back to its own onMessage listener
 * (Chrome explicitly excludes that path with "Could not establish
 * connection"). So the test reads via two channels:
 *   1. ServiceWorker.evaluate → globalThis.__savemediaDebug, which the
 *      SW exposes as a direct accessor over its in-memory router state.
 *   2. The popup page, which can roundtrip chrome.runtime.sendMessage
 *      normally because it's a different extension context.
 */

interface Descriptor {
  id: string;
  protocol: string;
  container: string;
  pageUrl: string;
  drm: null | { reason: string };
  capabilities: { drmBlocked: boolean; directDownload: boolean };
}

interface TabBucket { tabId: number; descriptors: Descriptor[] }

test.describe("extension classifies real fixture pages", () => {
  test.skip(!hasExtension, "dist-chrome/ not built; run `pnpm --filter @savemedia/extension build:chrome`");
  // Both describes drive an unpacked Chromium extension via the chromium
  // module directly. The firefox playwright project must skip them so it
  // doesn't try to launch a Chromium binary it hasn't installed.
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let context: BrowserContext | undefined;
  let sw: PlaywrightWorker | undefined;

  test.beforeAll(async ({ browserName }) => {
    // The describe-level test.skip() skips individual tests but Playwright
    // still runs the hooks; guard the chromium launch so the firefox
    // project doesn't try to spawn a binary it never installed.
    if (browserName !== "chromium") return;
    context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  async function descriptorsForUrlContaining(marker: string): Promise<Descriptor[]> {
    const buckets = (await sw!.evaluate((m: string) => {
      const dbg = (globalThis as unknown as { __savemediaDebug?: { listDescriptorsForUrl: (s: string) => unknown } }).__savemediaDebug;
      return dbg?.listDescriptorsForUrl(m) ?? [];
    }, marker)) as TabBucket[];
    return buckets.flatMap(b => b.descriptors);
  }

  async function waitForDescriptors(scenario: string, predicate: (d: Descriptor[]) => boolean): Promise<Descriptor[]> {
    const marker = `/page/${scenario}.html`;
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      for (let attempt = 0; attempt < 20; attempt++) {
        const descriptors = await descriptorsForUrlContaining(marker);
        if (predicate(descriptors)) return descriptors;
        await page.waitForTimeout(250);
      }
      return descriptorsForUrlContaining(marker);
    } finally {
      await page.close();
    }
  }

  test("direct MP4 fixture produces a progressive-http descriptor with directDownload", async () => {
    const descriptors = await waitForDescriptors("direct", ds => ds.some(d => d.protocol === "progressive-http"));
    const direct = descriptors.find(d => d.protocol === "progressive-http");
    expect(direct, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(direct?.capabilities.directDownload).toBe(true);
    expect(direct?.capabilities.drmBlocked).toBe(false);
  });

  test("HLS master fixture produces an hls descriptor", async () => {
    const descriptors = await waitForDescriptors("hls", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(hls?.capabilities.drmBlocked).toBe(false);
  });

  test("HLS fMP4 fixture ignores init/fragment .mp4 requests as standalone videos", async () => {
    const descriptors = await waitForDescriptors("hls-fmp4", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(descriptors.filter(d => d.protocol === "progressive-http")).toHaveLength(0);
  });

  test("DASH MPD fixture produces a dash descriptor", async () => {
    const descriptors = await waitForDescriptors("dash", ds => ds.some(d => d.protocol === "dash"));
    const dash = descriptors.find(d => d.protocol === "dash");
    expect(dash, `got ${JSON.stringify(descriptors)}`).toBeDefined();
  });

  test("widevine MPD is classified as DRM-blocked with reason cdm_required", async () => {
    const descriptors = await waitForDescriptors("widevine", ds => ds.some(d => d.drm?.reason === "cdm_required"));
    const drm = descriptors.find(d => d.drm?.reason === "cdm_required");
    expect(drm, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(drm?.capabilities.drmBlocked).toBe(true);
  });

  test("clearkey MPD surfaces clearkey_deferred (distinct from cdm_required)", async () => {
    const descriptors = await waitForDescriptors("clearkey", ds => ds.some(d => d.drm?.reason === "clearkey_deferred"));
    const ck = descriptors.find(d => d.drm?.reason === "clearkey_deferred");
    expect(ck, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(ck?.capabilities.drmBlocked).toBe(true);
  });

  test("negative page produces zero descriptors (no .jpg/.css/.js mis-classified as media)", async () => {
    const marker = "/page/negative.html";
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1_500);
      const descriptors = await descriptorsForUrlContaining(marker);
      expect(descriptors.filter(d => d.pageUrl.includes("/page/negative.html"))).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  test("content bridge discovers embedded HLS URLs before playback starts", async () => {
    const page = await context!.newPage();
    const extId = new URL(sw!.url()).host;
    const popup = await context!.newPage();
    try {
      await page.goto("/page/embedded-hls.html");
      await page.waitForLoadState("networkidle");
      await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);

      const response = await popup.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/embedded-hls.html"));
        if (!fixture?.id) return { ok: false, urls: [] as string[] };
        const discovered = await new Promise<{ urls?: string[] } | undefined>(resolve =>
          chrome.tabs.sendMessage(fixture.id!, { type: "discover-page-media" }, resp => resolve(resp)),
        );
        return { ok: true, urls: discovered?.urls ?? [] };
      });

      expect(response.ok).toBe(true);
      expect(response.urls.some(u => u.endsWith("/hls/master.m3u8"))).toBe(true);
      expect(response.urls.some(u => u.endsWith("/hls-fmp4/master.m3u8"))).toBe(true);
    } finally {
      await popup.close();
      await page.close();
    }
  });
});

test.describe("popup HTML round-trips chrome.runtime messaging", () => {
  test.skip(!hasExtension, "dist-chrome/ not built");
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let context: BrowserContext | undefined;
  let extId: string | undefined;

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    extId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("popup loads + sendMessage('list') from popup actually reaches the SW", async () => {
    // First populate state by visiting a fixture in a separate tab.
    const fixturePage = await context!.newPage();
    await fixturePage.goto("/page/direct.html");
    await fixturePage.waitForLoadState("networkidle");
    await fixturePage.waitForTimeout(800);

    const fixtureTabId = await fixturePage.evaluate(async () => {
      // The popup queries by tabId of the active tab; we surface the
      // current tab's id from chrome via the fixture page's own scripting
      // permission would be needed — instead we read it from the SW.
      return null;
    });
    expect(fixtureTabId).toBeNull(); // sanity (we don't have tabs perm in the page)

    const popup = await context!.newPage();
    try {
      await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
      await expect(popup.locator("header")).toContainText("savemedia");
      // Within the popup context, chrome.runtime.sendMessage DOES round-trip
      // to the SW listener. Probe the list response for the fixture tab.
      const popupSeen = await popup.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/direct.html"));
        if (!fixture?.id) return { ok: false, reason: "no fixture tab visible from popup" };
        const response: { descriptors?: unknown[] } | undefined = await new Promise(r =>
          chrome.runtime.sendMessage({ type: "list", tabId: fixture.id }, (resp: { descriptors?: unknown[] } | undefined) => r(resp)),
        );
        return { ok: true, descriptorCount: response?.descriptors?.length ?? 0, tabId: fixture.id };
      });
      expect(popupSeen).toMatchObject({ ok: true });
      if (popupSeen.ok) {
        expect(popupSeen.descriptorCount).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await popup.close();
      await fixturePage.close();
    }
  });

  test("Chrome registers Alt+S for the best-download command", async () => {
    const popup = await context!.newPage();
    try {
      await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
      const command = await popup.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.find(c => c.name === "download-best") ?? null;
      });
      expect(command?.name).toBe("download-best");
      expect(["Alt+S", "⌥S"]).toContain(command?.shortcut);
    } finally {
      await popup.close();
    }
  });
});
