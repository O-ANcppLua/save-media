import { useState } from "react";
import type { StreamDescriptor, OutputMode } from "@savemedia/core";
import { friendlyVideoCodec, friendlyAudioCodec } from "@savemedia/core";
import type { PopupToBackgroundMessage } from "../../types/messages";

interface Props {
  readonly descriptor: StreamDescriptor;
}

const OUTPUT_MODES: readonly OutputMode[] = ["Original", "MP4 Compatible", "Best Quality", "Small File", "Manual"];

export function DetectedItem({ descriptor }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<OutputMode>("Original");

  const visibleVariants = (descriptor.variants ?? []).filter(v => (v.height ?? 0) >= 720);
  const allBelowMin = descriptor.variants.length > 0 && visibleVariants.length === 0;
  const variant = visibleVariants[0] ?? descriptor.variants[0];
  const vcodec = variant?.videoCodec ?? descriptor.codecs.video;
  const acodec = variant?.audioCodec ?? descriptor.codecs.audio;
  const isDrmBlocked = descriptor.capabilities.drmBlocked;
  const isDeferred = descriptor.drm?.reason === "clearkey_deferred";

  function download() {
    if (isDrmBlocked) return;
    const msg: PopupToBackgroundMessage = {
      type: "download",
      streamId: descriptor.id,
      choice: {
        outputMode: mode,
        filename: filenameFor(descriptor),
        variantId: variant?.id ?? null,
        audioRenditionId: null,
      },
    };
    chrome.runtime.sendMessage(msg);
  }

  if (isDrmBlocked) {
    return (
      <li className="p-3 text-xs">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red-400">🔒</span>
          <span className="font-medium truncate">{descriptor.title ?? "Protected stream"}</span>
        </div>
        <p className="text-neutral-500 leading-relaxed">
          {isDeferred
            ? "ClearKey decryption deferred to v2."
            : "DRM-protected media. savemedia cannot decrypt this stream."}
        </p>
        <p className="text-neutral-600 mt-1">Reason: <code>{descriptor.drm?.reason}</code></p>
      </li>
    );
  }

  return (
    <li className="p-3 text-xs">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 w-full text-left mb-1"
      >
        <span className="text-neutral-500">{expanded ? "▼" : "▶"}</span>
        <span className="font-medium truncate flex-1">{descriptor.title ?? descriptor.pageUrl}</span>
      </button>

      <div className="text-neutral-400 ml-5 leading-relaxed">
        {variant && <>{variant.width}×{variant.height} · {variant.frameRate ?? "?"} fps · </>}
        {vcodec ? friendlyVideoCodec(vcodec) : "—"}
        {acodec && <> + {friendlyAudioCodec(acodec)}</>}
        {" · "}
        <code>{descriptor.container}</code>
        {allBelowMin && <span className="block text-amber-500 mt-0.5">⚠ source below 720p</span>}
      </div>

      {expanded && (
        <div className="mt-2 ml-5 space-y-1.5 text-neutral-400">
          <Row label="source type" value={descriptor.source.kind} />
          <Row label="protocol" value={descriptor.protocol} />
          <Row label="container" value={descriptor.container} />
          {variant?.bitrate && <Row label="bitrate" value={`${(variant.bitrate / 1e6).toFixed(1)} Mbps`} />}
          {variant?.estimatedSize && <Row label="size (est.)" value={`${(variant.estimatedSize / 1e6).toFixed(1)} MB`} />}
          <Row label="output action" value={descriptor.capabilities.directDownload ? "direct" : "remux"} />
        </div>
      )}

      <div className="mt-2 ml-5 flex items-center gap-2">
        <select
          value={mode}
          onChange={e => setMode(e.target.value as OutputMode)}
          className="bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-xs"
        >
          {OUTPUT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          onClick={download}
          className="ml-auto bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded text-xs"
        >
          ⬇ Download
        </button>
      </div>
    </li>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-neutral-600">{label}</span>
      <code className="truncate max-w-[60%] text-right">{value}</code>
    </div>
  );
}

function filenameFor(d: StreamDescriptor): string {
  const base = (d.title ?? "video").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `${base}.mp4`;
}
