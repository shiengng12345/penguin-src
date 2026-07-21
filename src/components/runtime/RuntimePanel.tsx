// Compact "Runtime" popover — Prevent Sleep toggle + mode choice.
// Penguin has no Backend/Docker/AI Worker/VPN subsystems, so this panel
// intentionally shows nothing beyond what the app actually manages: don't
// add placeholder status rows here.
//
// Everything Prevent-Sleep related lives here now — the mode radio used
// to live in the Settings dialog's "Runtime" card, but it was moved here
// so users manage the whole feature from one place (Task 13 follow-up).

import { Coffee } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useRuntime } from "@/hooks/useRuntime";
import { setPersistedValue } from "@/lib/app-persistence";
import { RUNTIME_PREVENT_SLEEP_KEY } from "@/lib/persistence-keys";
import type { PreventSleepPolicy } from "@/lib/runtime-client";

// Only two honest, working policy choices — Penguin has no Flow/Backend/AI
// subsystems, so "Ask Every Time" and the combinable auto-conditions from
// the original design are intentionally NOT offered here. auto_conditions
// always persists as [].
type PreventSleepUiMode = "never" | "on_startup";
const PREVENT_SLEEP_MODES: { value: PreventSleepUiMode; label: string }[] = [
  { value: "never", label: "Never — I'll turn it on manually" },
  { value: "on_startup", label: "Automatically when Penguin starts" },
];

export function RuntimePanel() {
  const { status, loading, togglePreventSleep, setMode } = useRuntime();
  const enabled = status?.prevent_sleep ?? false;
  const supported = status?.platform_supported ?? true;
  const mode: PreventSleepUiMode =
    status?.policy.mode === "never" ? "never" : "on_startup";

  const applyMode = (next: PreventSleepUiMode) => {
    const policy: PreventSleepPolicy = { mode: next, auto_conditions: [] };
    setPersistedValue(RUNTIME_PREVENT_SLEEP_KEY, JSON.stringify(policy));
    void setMode(policy);
  };

  return (
    <div className="w-72 rounded-lg border border-border bg-popover p-3 shadow-xl">
      <div className="mb-2 text-sm font-semibold text-foreground">
        Prevent Sleep / 防止休眠
      </div>

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

      <div className="mt-2 border-t border-border/60 pt-2">
        <RadioGroup value={mode} onValueChange={applyMode}>
          {PREVENT_SLEEP_MODES.map((m) => (
            <RadioGroupItem
              key={m.value}
              selected={mode === m.value}
              onSelect={() => applyMode(m.value)}
              label={m.label}
            />
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
