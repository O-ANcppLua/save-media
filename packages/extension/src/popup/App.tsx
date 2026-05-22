import { useEffect, useState } from "react";
import type { StreamDescriptor } from "@savemedia/core";
import type { BackgroundToPopupMessage, PopupToBackgroundMessage } from "../types/messages";
import { DetectedItem } from "./components/DetectedItem";

export function App() {
  const [descriptors, setDescriptors] = useState<readonly StreamDescriptor[]>([]);
  const [tabId, setTabId] = useState<number | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const id = tabs[0]?.id ?? null;
      setTabId(id);
      if (id === null) return;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: BackgroundToPopupMessage | undefined) => {
        if (response?.type === "descriptors") setDescriptors(response.descriptors);
      });
    });
  }, []);

  return (
    <main className="flex flex-col h-full">
      <header className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
        <span className="text-sm font-semibold">savemedia</span>
        <button
          aria-label="Settings"
          className="text-neutral-500 hover:text-neutral-300 text-xs"
          onClick={() => chrome.runtime.openOptionsPage?.()}
        >
          ⚙
        </button>
      </header>
      <section className="flex-1 overflow-y-auto">
        {descriptors.length === 0 ? (
          <div className="p-6 text-center text-neutral-500 text-xs">
            {tabId === null ? "No active tab." : "No media detected on this page."}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {descriptors.map(d => (
              <DetectedItem key={d.id} descriptor={d} />
            ))}
          </ul>
        )}
      </section>
      <footer className="px-3 py-1.5 border-t border-neutral-800 text-[10px] text-neutral-500 flex justify-between">
        <span>{descriptors.length} detected</span>
        <span>v0.0.1</span>
      </footer>
    </main>
  );
}
