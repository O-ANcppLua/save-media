import type {
  StreamDescriptor,
  UserChoice,
  JobError,
} from "@savemedia/core";

export const MAIN_BRIDGE_TAG = "__savemedia" as const;

export type CaptureKind =
  | "media-element"
  | "media-source"
  | "eme"
  | "ms-probe";

export interface MainToBridgeMessage {
  readonly [MAIN_BRIDGE_TAG]: true;
  readonly kind: CaptureKind;
  readonly url: string | null;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBodyHeadB64?: string;
  readonly keySystem?: string;
  readonly mimeType?: string;
  readonly elementTag?: "video" | "audio";
  readonly elementSrc?: string;
  readonly pageUrl: string;
}

export type BridgeToBackgroundMessage =
  | { readonly type: "capture"; readonly payload: MainToBridgeMessage }
  | { readonly type: "ready" };

export type BackgroundToContentMessage =
  | { readonly type: "discover-page-media" };

export interface ContentDiscoveryResponse {
  readonly pageUrl: string;
  readonly urls: readonly string[];
}

export type BackgroundToPopupMessage =
  | { readonly type: "descriptors"; readonly tabId: number; readonly descriptors: readonly StreamDescriptor[] }
  | { readonly type: "job-progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "job-failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError }
  | { readonly type: "job-complete"; readonly streamId: StreamDescriptor["id"]; readonly path: string };

export type PopupToBackgroundMessage =
  | { readonly type: "list"; readonly tabId: number }
  | { readonly type: "download"; readonly streamId: StreamDescriptor["id"]; readonly choice: UserChoice }
  | { readonly type: "cancel"; readonly streamId: StreamDescriptor["id"] };

export type BackgroundToEngineMessage =
  | { readonly type: "start-job"; readonly streamId: StreamDescriptor["id"]; readonly descriptor: StreamDescriptor; readonly choice: UserChoice }
  | { readonly type: "cancel-job"; readonly streamId: StreamDescriptor["id"] };

export type EngineToBackgroundMessage =
  | { readonly type: "progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "complete"; readonly streamId: StreamDescriptor["id"]; readonly blobUrl: string; readonly filename: string; readonly checksum: string }
  | { readonly type: "failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError };
