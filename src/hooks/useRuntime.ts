import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "@/components/ui/toast";
import {
  getRuntimeStatus,
  setPreventSleep,
  setRuntimeMode,
  type PreventSleepPolicy,
  type RuntimeStatus,
} from "@/lib/runtime-client";

export function useRuntime() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getRuntimeStatus());
    } catch (e) {
      console.error("runtime status failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const un = listen<{ enabled: boolean }>("runtime://transition", (evt) => {
      refresh();
      toast(evt.payload.enabled ? "☕ Prevent Sleep Enabled" : "☕ Prevent Sleep Disabled");
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [refresh]);

  const togglePreventSleep = useCallback(async (enabled: boolean) => {
    setLoading(true);
    try {
      await setPreventSleep(enabled);
    } catch (e) {
      toast(String(e)); // backend returns the friendly "Unable to prevent…" string
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const setMode = useCallback(async (policy: PreventSleepPolicy) => {
    await setRuntimeMode(policy);
    await refresh();
  }, [refresh]);

  return { status, loading, togglePreventSleep, setMode, refresh };
}
