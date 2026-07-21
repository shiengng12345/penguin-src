import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  setPreventSleep,
  setRuntimeMode,
  type PreventSleepPolicy,
} from "@/lib/runtime-client";
import { ensureRuntimeListener, useRuntimeStore } from "@/lib/runtime-store";

export function useRuntime() {
  const status = useRuntimeStore((s) => s.status);
  const refresh = useRuntimeStore((s) => s.refresh);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    ensureRuntimeListener();
  }, []);

  const togglePreventSleep = useCallback(async (enabled: boolean) => {
    setLoading(true);
    try {
      await setPreventSleep(enabled);
    } catch (e) {
      toast(String(e)); // backend returns the friendly "Unable to prevent…" string
    } finally {
      setLoading(false);
    }
  }, []);

  const setMode = useCallback(async (policy: PreventSleepPolicy) => {
    await setRuntimeMode(policy);
    await refresh();
  }, [refresh]);

  return { status, loading, togglePreventSleep, setMode, refresh };
}
