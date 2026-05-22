import { MAIN_BRIDGE_TAG, type MainToBridgeMessage, type BridgeToBackgroundMessage } from "../types/messages";

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data as MainToBridgeMessage | null;
  if (!data || data[MAIN_BRIDGE_TAG] !== true) return;
  const msg: BridgeToBackgroundMessage = { type: "capture", payload: data };
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
});

chrome.runtime.sendMessage({ type: "ready" } satisfies BridgeToBackgroundMessage, () => void chrome.runtime.lastError);
