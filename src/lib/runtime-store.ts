import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "@/components/ui/toast";
import { getRuntimeStatus, type RuntimeStatus } from "@/lib/runtime-client";

interface RuntimeStoreState {
  status: RuntimeStatus | null;
  refresh: () => Promise<void>;
}

export const useRuntimeStore = create<RuntimeStoreState>((set) => ({
  status: null,
  refresh: async () => {
    try {
      set({ status: await getRuntimeStatus() });
    } catch (e) {
      console.error("runtime status failed", e);
    }
  },
}));

let listenerStarted = false;
// Retained for the app's lifetime; not unsubscribed, but kept for potential
// future teardown/debugging (e.g. hot-reload in dev).
let unlisten: UnlistenFn | null = null;
void unlisten;

export function ensureRuntimeListener() {
  if (listenerStarted) return;
  listenerStarted = true;

  useRuntimeStore.getState().refresh();

  listen<{ enabled: boolean }>("runtime://transition", (evt) => {
    useRuntimeStore.getState().refresh();
    toast(evt.payload.enabled ? "☕ Prevent Sleep Enabled" : "☕ Prevent Sleep Disabled");
  })
    .then((f) => {
      unlisten = f;
      void unlisten;
    })
    .catch(() => {});
}
