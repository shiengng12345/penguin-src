import { invoke } from "@tauri-apps/api/core";

export type RuntimeSource = "flow" | "backend" | "ai" | "docker" | "manual";
export type PreventSleepMode = "never" | "ask_every_time" | "on_startup" | "auto";

export interface PreventSleepPolicy {
  mode: PreventSleepMode;
  auto_conditions: RuntimeSource[];
}

export interface RuntimeStatus {
  prevent_sleep: boolean;
  platform_supported: boolean;
  sources: { source: RuntimeSource; count: number }[];
  policy: PreventSleepPolicy;
}

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_get_status");
}

export function setPreventSleep(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("runtime_set_prevent_sleep", { enabled });
}

export function setRuntimeMode(policy: PreventSleepPolicy): Promise<void> {
  return invoke("runtime_set_mode", { policy });
}
