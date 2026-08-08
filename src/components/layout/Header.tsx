import { useState, useMemo, useCallback, memo } from "react";
import { ThemedMascotImg } from "@/components/common/ThemedMascotImg";
import {
  useAppStore,
  THEMES,
  ENV_COLORS,
  type Environment,
  type ProtocolTab,
} from "@/lib/store";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useGreeting } from "@/hooks/useGreeting";
import { useClock } from "@/hooks/useClock";
import type { AppUpdateController } from "@/hooks/useAppUpdateScheduler";
import { syncRemoteConfigForProtocol } from "@/lib/environment-sync";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Palette, Settings, Clock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface HeaderProps {
  onOpenSettings: () => void;
  appUpdate: AppUpdateController;
  showClientControls: boolean;
}

const PROTOCOL_LABELS: Record<string, string> = {
  "grpc-web": "gRPC-Web",
  grpc: "gRPC",
  sdk: "JS-SDK",
  rest: "REST",
};

function setEnvsForProtocolState(
  state: ReturnType<typeof useAppStore.getState>,
  protocol: ProtocolTab,
  environments: Environment[],
): void {
  if (protocol === "grpc-web") state.setGrpcWebEnvironments(environments);
  else if (protocol === "grpc") state.setGrpcEnvironments(environments);
  else if (protocol === "sdk") state.setSdkEnvironments(environments);
  else state.setRestEnvironments(environments);
}

function setActiveEnvForProtocolState(
  state: ReturnType<typeof useAppStore.getState>,
  protocol: ProtocolTab,
  activeEnvId: string | null,
): void {
  if (protocol === "grpc-web") state.setGrpcWebActiveEnvId(activeEnvId);
  else if (protocol === "grpc") state.setGrpcActiveEnvId(activeEnvId);
  else if (protocol === "sdk") state.setSdkActiveEnvId(activeEnvId);
  else state.setRestActiveEnvId(activeEnvId);
}

const PenguinBrand = memo(function PenguinBrand() {
  const greeting = useGreeting();
  const { time, isLunch, lunchMsg } = useClock();

  return (
    <div className="flex items-center gap-2 min-w-0">
      <ThemedMascotImg
        base="/penguin.png"
        alt="Penguin"
        className={cn("h-8 shrink-0 object-contain", isLunch && "animate-bounce")}
        draggable={false}
      />
      <span
        className={cn(
          "text-sm font-medium truncate max-w-[280px]",
          isLunch ? "text-warning" : "text-foreground"
        )}
        title={isLunch ? lunchMsg : greeting}
      >
        {isLunch ? lunchMsg : greeting}
      </span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 shrink-0">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-mono font-medium text-muted-foreground tabular-nums">
          {time}
        </span>
      </div>
    </div>
  );
});

export function Header({ onOpenSettings, appUpdate, showClientControls }: HeaderProps) {
  const { theme, setTheme } = useAppStore();
  const {
    environments,
    activeEnvId,
    setActiveEnvId,
    protocol,
  } = useEnvironments();

  const [themePopoverOpen, setThemePopoverOpen] = useState(false);
  const [isSyncingEnvConfig, setIsSyncingEnvConfig] = useState(false);
  const [envSyncTitle, setEnvSyncTitle] = useState("Sync Environment Config");

  const protocolName = PROTOCOL_LABELS[protocol] ?? protocol;
  const envOptions = useMemo(
    () =>
      environments.map((e) => ({
        value: e.id,
        label: e.name,
        color: ENV_COLORS.find((c) => c.id === e.color)?.hex,
      })),
    [environments]
  );
  const syncEnvironmentConfig = useCallback(async () => {
    setIsSyncingEnvConfig(true);
    try {
      const result = await syncRemoteConfigForProtocol({
        protocol,
        environments,
        activeEnvId,
      });

      if (result.changed) {
        const state = useAppStore.getState();
        setEnvsForProtocolState(state, protocol, result.environments);
        setActiveEnvForProtocolState(state, protocol, result.activeEnvId);
      }

      setEnvSyncTitle(
        `Sync Environment Config: added ${result.added.length}, unchanged ${result.skipped.length}, local kept ${result.conflicts.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync config";
      setEnvSyncTitle(`Sync Environment Config failed: ${message}`);
    } finally {
      setIsSyncingEnvConfig(false);
    }
  }, [activeEnvId, environments, protocol]);

  return (
    <header className="relative z-40 flex h-10 shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <PenguinBrand />

      <div className="flex items-center gap-2">
        {showClientControls ? (
          <>
            <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {protocolName}
            </span>

            <Select
              value={activeEnvId ?? ""}
              onChange={(e) => setActiveEnvId(e.target.value || null)}
              options={envOptions}
              placeholder="Environment / 环境"
              className="w-36"
            />

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={syncEnvironmentConfig}
              disabled={isSyncingEnvConfig}
              title={envSyncTitle}
              aria-label="Sync Environment Config"
            >
              <RefreshCw className={cn("h-4 w-4", isSyncingEnvConfig && "animate-spin")} />
            </Button>
          </>
        ) : null}

        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setThemePopoverOpen((o) => !o)}
            title="Theme / 主题"
          >
            <Palette className="h-4 w-4" />
          </Button>
          {themePopoverOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setThemePopoverOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-popover p-1 shadow-xl">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setTheme(t.id);
                      setThemePopoverOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent",
                      theme === t.id && "bg-accent font-medium text-accent-foreground"
                    )}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-border/50"
                      style={{ backgroundColor: t.color }}
                    />
                    <span>{t.label}</span>
                    {theme === t.id && (
                      <span className="ml-auto text-[10px] text-primary">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onOpenSettings}
            title={
              appUpdate.hasVisibleUpdate && appUpdate.updateVersion
                ? `Update available v${appUpdate.updateVersion}`
                : "Settings / 设置"
            }
          >
            <Settings className="h-4 w-4" />
          </Button>
          {appUpdate.hasVisibleUpdate && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--card))]" />
          )}
        </div>
      </div>
    </header>
  );
}
