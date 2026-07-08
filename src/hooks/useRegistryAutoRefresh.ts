import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { useRegistryPoll } from "@/hooks/useRegistryPoll";
import { useAppStore } from "@/lib/store";
import {
  canBackgroundRefreshRegistry,
  REGISTRY_AUTO_REFRESH_BACKGROUND_MS,
} from "@/lib/registry-auto-refresh";

// App-level background poller. While the installer is CLOSED, keep the registry
// package cache warm (relaxed 30s cadence) so admins / super-admins reopen to a
// fresh list. While the installer is OPEN, its own poll (fast 5s) owns refresh,
// so this one stands down — the two never double-fetch. Strictly gated: the
// moment dev mode is off, the dev token is invalid, or the toggle is off, the
// poll tears down. Mounted once, at the app root.
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

  useRegistryPoll(active, REGISTRY_AUTO_REFRESH_BACKGROUND_MS);
}
