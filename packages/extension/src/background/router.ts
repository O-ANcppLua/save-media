import {
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
  type JobPlan,
  type DispatchRefusal,
  type DrmReason,
  type OutputContainer,
  type Variant,
} from "@savemedia/core";
import type {
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../types/messages";
import type { Logger } from "../util/logger";
import { suggestFilename } from "../util/filename";

type HlsDescriptor = StreamDescriptor & {
  readonly source: { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" };
};

export interface TabState {
  readonly descriptors: Map<string, StreamDescriptor>;
}

export interface RouterDeps {
  readonly runtime: {
    sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void;
  };
  readonly downloads: {
    download: (opts: { url: string; filename: string; conflictAction?: string }) => Promise<number>;
  };
  readonly ensureEngineHost: () => Promise<void>;
  readonly logger?: Logger;
}

export interface Router {
  readonly tabs: Map<number, TabState>;
  readonly jobs: Map<StreamDescriptor["id"], { descriptor: StreamDescriptor; choice: UserChoice; plan: JobPlan }>;
  readonly addDescriptor: (tabId: number, descriptor: StreamDescriptor) => boolean;
  readonly listDescriptors: (tabId: number) => readonly StreamDescriptor[];
  readonly findDescriptor: (id: StreamDescriptor["id"]) => StreamDescriptor | null;
  readonly clearTab: (tabId: number) => void;
  readonly startDownload: (id: StreamDescriptor["id"], choice: UserChoice) => Promise<JobError | null>;
  readonly startBestDownload: (tabId: number) => Promise<{ streamId: StreamDescriptor["id"]; error: JobError } | null>;
  readonly handleEngineMessage: (msg: EngineToBackgroundMessage) => Promise<BackgroundToPopupMessage | null>;
  readonly handlePopupMessage: (
    msg: PopupToBackgroundMessage,
  ) => Promise<BackgroundToPopupMessage | { ok: true } | null>;
}

export function createRouter(deps: RouterDeps): Router {
  const tabs = new Map<number, TabState>();
  const jobs = new Map<StreamDescriptor["id"], { descriptor: StreamDescriptor; choice: UserChoice; plan: JobPlan }>();

  function getTab(tabId: number): TabState {
    let s = tabs.get(tabId);
    if (!s) {
      s = { descriptors: new Map() };
      tabs.set(tabId, s);
    }
    return s;
  }

  function descriptorKey(d: StreamDescriptor): string {
    const src = d.source.kind === "direct-url"
      ? d.source.url
      : d.source.kind === "hls-manifest" || d.source.kind === "dash-manifest"
        ? d.source.manifestUrl
        : d.source.elementSrc;
    return `${d.source.kind}:${d.protocol}:${src}`;
  }

  /**
   * Tube sites often serve a video as N sequential `.mp4` fragments at
   * URLs that differ only by a numeric component (segment-1.mp4,
   * segment-2.mp4, ...). Without a master playlist we can't stitch them,
   * but we MUST stop surfacing each fragment as a separate "download
   * this video" entry — otherwise the popup fills with junk and the
   * user gets N partial files when they click around.
   *
   * Heuristic: collapse any contiguous run of 2+ digits in the URL to
   * `#` and use that as the segment-family key. The first URL in a
   * family is kept; siblings are suppressed.
   */
  function segmentFamilyKey(d: StreamDescriptor): string | null {
    if (d.source.kind !== "direct-url") return null;
    const url = d.source.url;
    const normalised = url.replace(/\d{2,}/g, "#");
    if (normalised === url) return null; // no numeric component → not segment-shaped
    return `direct-family:${d.protocol}:${normalised}`;
  }

  function hlsVariantPlaylistUrls(d: StreamDescriptor): Set<string> {
    const urls = new Set<string>();
    if (d.protocol !== "hls") return urls;
    for (const v of d.variants) {
      if (v.segmentRef.kind === "hls-segments") urls.add(v.segmentRef.playlistUrl);
    }
    return urls;
  }

  function isHlsMediaPlaylist(d: StreamDescriptor): d is HlsDescriptor & { readonly source: HlsDescriptor["source"] & { readonly type: "media" } } {
    return d.source.kind === "hls-manifest" && d.source.type === "media";
  }

  function isHlsMasterPlaylist(d: StreamDescriptor): d is HlsDescriptor & { readonly source: HlsDescriptor["source"] & { readonly type: "master" } } {
    return d.source.kind === "hls-manifest" && d.source.type === "master";
  }

  function removeCoveredHlsMediaDescriptors(state: TabState, master: StreamDescriptor): void {
    const covered = hlsVariantPlaylistUrls(master);
    if (covered.size === 0) return;
    for (const [k, existing] of state.descriptors.entries()) {
      if (isHlsMediaPlaylist(existing) && covered.has(existing.source.manifestUrl)) {
        state.descriptors.delete(k);
      }
    }
  }

  function hlsMediaCoveredByExistingMaster(state: TabState, media: StreamDescriptor): boolean {
    if (!isHlsMediaPlaylist(media)) return false;
    for (const existing of state.descriptors.values()) {
      if (isHlsMasterPlaylist(existing) && hlsVariantPlaylistUrls(existing).has(media.source.manifestUrl)) {
        return true;
      }
    }
    return false;
  }

  function addDescriptor(tabId: number, descriptor: StreamDescriptor): boolean {
    const state = getTab(tabId);
    if (hlsMediaCoveredByExistingMaster(state, descriptor)) return false;
    if (isHlsMasterPlaylist(descriptor)) removeCoveredHlsMediaDescriptors(state, descriptor);

    const key = descriptorKey(descriptor);
    if (state.descriptors.has(key)) return false;
    const family = segmentFamilyKey(descriptor);
    if (family && state.descriptors.has(family)) {
      // A sibling segment from this URL family is already on file; drop.
      return false;
    }
    state.descriptors.set(key, descriptor);
    if (family) state.descriptors.set(family, descriptor);
    return true;
  }

  function listDescriptors(tabId: number): readonly StreamDescriptor[] {
    const all = Array.from(tabs.get(tabId)?.descriptors.values() ?? []);
    // De-dupe identity in case the same descriptor was indexed under both
    // its primary key AND a segment-family key.
    const seen = new Set<string>();
    return all.filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }

  function findDescriptor(id: StreamDescriptor["id"]): StreamDescriptor | null {
    for (const state of tabs.values()) {
      for (const d of state.descriptors.values()) if (d.id === id) return d;
    }
    return null;
  }

  function clearTab(tabId: number): void {
    tabs.delete(tabId);
  }

  function bestVariant(d: StreamDescriptor): Variant | null {
    if (d.variants.length === 0) return null;
    const sorted = [...d.variants].sort((a, b) => {
      const h = (b.height ?? 0) - (a.height ?? 0);
      if (h !== 0) return h;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
    return sorted[0] ?? null;
  }

  function outputContainerFor(d: StreamDescriptor): OutputContainer {
    if (d.container === "webm") return "webm";
    if (d.container === "mkv") return "mkv";
    return "mp4";
  }

  function bestDescriptorScore(d: StreamDescriptor): [number, number, number, number] {
    const variant = bestVariant(d);
    const protocolRank = d.protocol === "hls" || d.protocol === "dash"
      ? 3
      : d.protocol === "progressive-http"
        ? 2
        : 1;
    return [
      variant?.height ?? 0,
      variant?.bitrate ?? 0,
      protocolRank,
      d.detectedAt,
    ];
  }

  function compareBestDescriptors(a: StreamDescriptor, b: StreamDescriptor): number {
    const as = bestDescriptorScore(a);
    const bs = bestDescriptorScore(b);
    for (let i = 0; i < as.length; i++) {
      const diff = (bs[i] ?? 0) - (as[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.id.localeCompare(b.id);
  }

  function bestDownloadChoice(d: StreamDescriptor): UserChoice {
    const variant = bestVariant(d);
    return {
      outputMode: "Original",
      filename: suggestFilename(d, outputContainerFor(d)),
      variantId: variant?.id ?? null,
      audioRenditionId: variant?.audioRenditionId ?? null,
    };
  }

  async function startBestDownload(tabId: number): Promise<{ streamId: StreamDescriptor["id"]; error: JobError } | null> {
    const descriptor = [...listDescriptors(tabId)]
      .filter(d => !d.capabilities.drmBlocked)
      .sort(compareBestDescriptors)[0];
    if (!descriptor) return null;

    const error = await startDownload(descriptor.id, bestDownloadChoice(descriptor));
    return error ? { streamId: descriptor.id, error } : null;
  }

  async function startDownload(id: StreamDescriptor["id"], choice: UserChoice): Promise<JobError | null> {
    const descriptor = findDescriptor(id);
    if (!descriptor) {
      return { code: "manifest_404", severity: "terminal", url: "", httpStatus: 0 };
    }

    const plan: JobPlan | DispatchRefusal = dispatch(descriptor, choice);

    if (plan.kind === "refuse") {
      return drmRefusalToError(plan.reason, descriptor);
    }

    if (plan.kind === "direct") {
      try {
        await deps.downloads.download({
          url: plan.url,
          filename: plan.filename,
          conflictAction: "uniquify",
        });
        return null;
      } catch (err) {
        return {
          code: "native_sink_io_error",
          severity: "terminal",
          errno: String((err as Error)?.message ?? err),
          path: plan.filename,
        };
      }
    }

    jobs.set(id, { descriptor, choice, plan });
    await deps.ensureEngineHost();
    const engineMsg: BackgroundToEngineMessage = { type: "start-job", streamId: id, descriptor, choice };
    deps.runtime.sendMessage(engineMsg);
    return null;
  }

  async function handleEngineMessage(msg: EngineToBackgroundMessage): Promise<BackgroundToPopupMessage | null> {
    if (msg.type === "progress") {
      return {
        type: "job-progress",
        streamId: msg.streamId,
        bytesWritten: msg.bytesWritten,
        bytesTotal: msg.bytesTotal,
        phase: msg.phase,
      };
    }
    if (msg.type === "complete") {
      jobs.delete(msg.streamId);
      // Native paths already wrote the file to disk (blobUrl is a file://
      // URL there); skip handing it to chrome.downloads, which would fail
      // on file: schemes anyway.
      if (msg.blobUrl.startsWith("file://")) {
        return { type: "job-complete", streamId: msg.streamId, path: msg.filename };
      }
      try {
        await deps.downloads.download({
          url: msg.blobUrl,
          filename: msg.filename,
          conflictAction: "uniquify",
        });
        return { type: "job-complete", streamId: msg.streamId, path: msg.filename };
      } catch (err) {
        return {
          type: "job-failed",
          streamId: msg.streamId,
          error: {
            code: "native_sink_io_error",
            severity: "terminal",
            errno: err instanceof Error ? err.message : String(err),
            path: msg.filename,
          },
        };
      }
    }
    if (msg.type === "failed") {
      jobs.delete(msg.streamId);
      return { type: "job-failed", streamId: msg.streamId, error: msg.error };
    }
    return null;
  }

  async function handlePopupMessage(
    msg: PopupToBackgroundMessage,
  ): Promise<BackgroundToPopupMessage | { ok: true } | null> {
    if (msg.type === "list") {
      return { type: "descriptors", tabId: msg.tabId, descriptors: listDescriptors(msg.tabId) };
    }
    if (msg.type === "download") {
      const err = await startDownload(msg.streamId, msg.choice);
      if (err) {
        const failMsg: BackgroundToPopupMessage = { type: "job-failed", streamId: msg.streamId, error: err };
        deps.runtime.sendMessage(failMsg);
      }
      return { ok: true };
    }
    if (msg.type === "cancel") {
      jobs.delete(msg.streamId);
      const engineMsg: BackgroundToEngineMessage = { type: "cancel-job", streamId: msg.streamId };
      deps.runtime.sendMessage(engineMsg);
      return { ok: true };
    }
    return null;
  }

  return {
    tabs,
    jobs,
    addDescriptor,
    listDescriptors,
    findDescriptor,
    clearTab,
    startDownload,
    startBestDownload,
    handleEngineMessage,
    handlePopupMessage,
  };
}

export function drmRefusalToError(reason: DrmReason, d: StreamDescriptor): JobError {
  const drm = d.drm;
  switch (reason) {
    case "encrypted_media_detected":
      return {
        code: "encrypted_media_detected",
        severity: "terminal",
        detectedVia: drm?.detectedVia ?? [],
        keySystem: drm?.keySystem ?? null,
      };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: drm?.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: d.pageUrl };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: d.pageUrl };
  }
}
