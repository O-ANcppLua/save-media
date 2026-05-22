import {
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
  type JobPlan,
  type DispatchRefusal,
  type DrmReason,
} from "@savemedia/core";
import type {
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../types/messages";
import type { Logger } from "../util/logger";

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

  function addDescriptor(tabId: number, descriptor: StreamDescriptor): boolean {
    const state = getTab(tabId);
    const key = descriptorKey(descriptor);
    if (state.descriptors.has(key)) return false;
    state.descriptors.set(key, descriptor);
    return true;
  }

  function listDescriptors(tabId: number): readonly StreamDescriptor[] {
    return Array.from(tabs.get(tabId)?.descriptors.values() ?? []);
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
