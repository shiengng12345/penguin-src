export interface McpStatusSnapshot {
  configured: boolean;
  launcherHealthy: boolean;
  initializeHealthy: boolean | null;
  clientRestartRequired: boolean | null;
  runtimeOutdated: boolean | null;
}

export interface McpHealthSnapshot {
  initializeHealthy: boolean | null;
  clientRestartRequired: boolean | null;
  runtimeOutdated: boolean | null;
}

export type McpConfigWriteResult = "not-run" | "written" | "unchanged";

export interface McpStatusViewInput {
  status: McpStatusSnapshot | null;
  health: McpHealthSnapshot | null;
  writeResult: McpConfigWriteResult;
  pendingClientReload: boolean;
}

export interface McpStatusView {
  canCopySetup: boolean;
  configurationLabel: "Configuration present" | "Configuration not present";
  writeLabel: string;
  statusLabel: string;
  runtimeOutdated: boolean;
  clientReloadNotice: string | null;
  runtimeNotice: string | null;
  copyDisabledNotice: string | null;
}

export function deriveMcpStatusView(input: McpStatusViewInput): McpStatusView {
  const runtimeOutdated = input.health?.runtimeOutdated === true || input.status?.runtimeOutdated === true;
  const localInitializeHealthy = input.health?.initializeHealthy ?? input.status?.initializeHealthy;
  const localHealthFailed = localInitializeHealthy === false;
  const configured = input.status?.configured === true;

  return {
    canCopySetup: input.status?.launcherHealthy === true,
    configurationLabel: configured ? "Configuration present" : "Configuration not present",
    writeLabel:
      input.writeResult === "written"
        ? "Configuration written this session"
        : input.writeResult === "unchanged"
          ? "Configuration already present; nothing written this session"
          : "No configuration change in this session",
    statusLabel: runtimeOutdated
      ? "Runtime Outdated — Restart Required"
      : localHealthFailed
        ? "Server Check Failed"
        : input.pendingClientReload
          ? "Configuration Changed — Restart May Be Required"
          : configured
            ? "Configuration Present"
            : "Manual Setup",
    runtimeOutdated,
    clientReloadNotice: input.pendingClientReload
      ? "This configuration change has not been loaded by the client; restart may be required."
      : null,
    runtimeNotice: runtimeOutdated
      ? "The local MCP probe is serving an older runtime; restart the MCP session, then reconfigure if it remains outdated."
      : null,
    copyDisabledNotice:
      input.status !== null && !input.status.launcherHealthy
        ? "Stable MCP launcher is not ready; finish launcher installation before copying setup."
        : null,
  };
}
