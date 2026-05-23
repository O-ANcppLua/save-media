import type { JobError, StreamDescriptor } from "@savemedia/core";
import {
  MAIN_BRIDGE_TAG,
  type BackgroundToContentMessage,
  type BackgroundToPopupMessage,
  type BridgeToBackgroundMessage,
  type ContentDiscoveryResponse,
} from "../types/messages";

type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

interface ActiveTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
}

export interface DownloadBestDeps {
  readonly tabs: {
    readonly query: (queryInfo: { readonly active: true; readonly currentWindow: true }) => Promise<readonly ActiveTab[]>;
    readonly sendMessage: (
      tabId: number,
      msg: BackgroundToContentMessage,
      cb: (response: ContentDiscoveryResponse | undefined) => void,
    ) => void;
  };
  readonly runtime: {
    readonly lastError: () => unknown;
    readonly sendMessage: (msg: BackgroundToPopupMessage, cb?: () => void) => void;
  };
  readonly router: {
    readonly startBestDownload: (
      tabId: number,
    ) => Promise<{ streamId: StreamDescriptor["id"]; error: JobError } | null>;
  };
  readonly handleCapture: (tabId: number, msg: CaptureMessage) => Promise<void>;
}

export interface CommandsLike {
  readonly onCommand: {
    readonly addListener: (listener: (command: string) => void) => void;
  };
}

export async function discoverPageMediaForTab(
  deps: Pick<DownloadBestDeps, "tabs" | "runtime" | "handleCapture">,
  tabId: number,
  fallbackPageUrl: string,
): Promise<void> {
  const request: BackgroundToContentMessage = { type: "discover-page-media" };
  const response = await new Promise<ContentDiscoveryResponse | null>(resolve => {
    deps.tabs.sendMessage(tabId, request, resp => {
      if (deps.runtime.lastError()) {
        resolve(null);
        return;
      }
      resolve(resp ?? null);
    });
  });

  if (!response) return;
  const pageUrl = response.pageUrl || fallbackPageUrl;
  for (const url of response.urls) {
    await deps.handleCapture(tabId, {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "media-source",
        url,
        pageUrl,
      },
    });
  }
}

export async function downloadBestForActiveTab(deps: DownloadBestDeps): Promise<void> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await discoverPageMediaForTab(deps, tab.id, tab.url ?? "");
  const failure = await deps.router.startBestDownload(tab.id);
  if (failure) {
    const msg: BackgroundToPopupMessage = {
      type: "job-failed",
      streamId: failure.streamId,
      error: failure.error,
    };
    deps.runtime.sendMessage(msg, () => undefined);
  }
}

export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps): void {
  commands?.onCommand.addListener(command => {
    if (command === "download-best") void downloadBestForActiveTab(deps);
  });
}
