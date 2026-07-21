// Compact "Runtime" popover — currently just the Prevent Sleep toggle.
// Penguin has no Backend/Docker/AI Worker/VPN subsystems, so this panel
// intentionally shows nothing beyond what the app actually manages: don't
// add placeholder status rows here.

import { Coffee } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useRuntime } from "@/hooks/useRuntime";

interface RuntimePanelProps {
  onOpenSettings: () => void;
}

export function RuntimePanel({ onOpenSettings }: RuntimePanelProps) {
  const { status, loading, togglePreventSleep } = useRuntime();
  const enabled = status?.prevent_sleep ?? false;
  const supported = status?.platform_supported ?? true;

  return (
    <div className="w-72 rounded-lg border border-border bg-popover p-3 shadow-xl">
      <div className="mb-2 text-sm font-semibold text-foreground">Runtime</div>

      <div className="flex items-center justify-between py-1.5">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Coffee className="h-4 w-4" />
          Prevent Sleep
        </span>
        <Switch
          checked={enabled}
          disabled={loading || !supported}
          onCheckedChange={togglePreventSleep}
          aria-label="Prevent Sleep"
        />
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Prevent this computer from sleeping while Penguin is running.
      </p>
      {!supported && (
        <p className="mb-2 text-xs text-amber-500">
          Not supported on this platform.
        </p>
      )}

      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-1 w-full rounded-md px-1 py-1 text-left text-xs text-primary transition-colors hover:bg-accent"
      >
        ⚙ Runtime Settings →
      </button>
    </div>
  );
}
