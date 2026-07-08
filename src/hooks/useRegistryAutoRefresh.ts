import { useEffect } from "react";
import { fetchRegistryPackages } from "@/lib/registry-search";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { useAppStore } from "@/lib/store";
import {
  canBackgroundRefreshRegistry,
  REGISTRY_AUTO_REFRESH_INTERVAL_MS,
} from "@/lib/registry-auto-refresh";

// App-level background poller. While the installer is CLOSED, keep the registry
// package cache warm every 5s so admins / super-admins reopen to a fresh list.
// While the installer is OPEN, its own effect owns refresh (and pauses during an
// install), so this poller stands down to avoid double-fetching. Strictly gated:
// the moment dev mode is off, the dev token is invalid, or the toggle is off,
// the interval is torn down. Mounted once, at the app root.
export function useRegistryAutoRefresh(): void {
  const { enabled: devModeEnabled, hasValidToken } = useDeveloperMode();
  const installerAutoRefresh = useAppStore((s) => s.installerAutoRefresh);
  const isInstallerOpen = useAppStore((s) => s.isInstallerOpen);

  const active =
    canBackgroundRefreshRegistry({
      enabled: installerAutoRefresh,
      devModeEnabled,
      hasValidToken,
    }) && !isInstallerOpen;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      // silent cache warm — result lands in the memory + disk cache (and, for
      // any listener, via registry-search:enriched events); errors are ignored.
      void fetchRegistryPackages({ force: true }).catch(() => {});
    };
    tick(); // refresh right away when it becomes active (e.g. installer just closed)
    const id = setInterval(() => {
      if (!cancelled) tick();
    }, REGISTRY_AUTO_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);
}
