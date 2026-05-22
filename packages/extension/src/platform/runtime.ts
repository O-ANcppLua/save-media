export const runtime = (globalThis as unknown as { chrome: typeof chrome }).chrome;

export function getActiveTabId(): Promise<number | null> {
  return new Promise(resolve => {
    runtime.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

export function sendToTab<T>(tabId: number, msg: unknown): Promise<T | null> {
  return new Promise(resolve => {
    runtime.tabs.sendMessage(tabId, msg, (response: T | null) => {
      if (runtime.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}
