import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Loader2, PlugZap, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shouldShowReleaseWelcome } from "@/lib/app-update";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";

type McpRefreshState = "refreshing" | "ready" | "needs-attention";

interface ReleaseWelcomeDialogProps {
  onOpenMcpSettings: () => void;
}

export function ReleaseWelcomeDialog({ onOpenMcpSettings }: ReleaseWelcomeDialogProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [mcpRefreshState, setMcpRefreshState] = useState<McpRefreshState>("refreshing");

  useEffect(() => {
    let active = true;

    void getVersion()
      .then(async (currentVersion) => {
        if (!active || !shouldShowReleaseWelcome({
          currentVersion,
          lastSeenVersion: getPersistedValue(APP_VALUE_KEYS.releaseWelcomeSeenVersion),
        })) {
          return;
        }

        setVersion(currentVersion);
        try {
          // This refreshes the stable ~/.penguin/mcp runtime and rewrites only
          // detected Claude/Codex clients to the canonical `penguin` entry.
          await invoke<string>("mcp_install_to_local_clients");
          if (active) setMcpRefreshState("ready");
        } catch {
          // A machine with no supported AI client, or an unwritable client
          // config, can retry explicitly from Settings without blocking App boot.
          if (active) setMcpRefreshState("needs-attention");
        }
      })
      .catch(() => {
        // An unavailable app version cannot be acknowledged reliably, so do
        // not show a dialog that would repeat forever.
      });

    return () => {
      active = false;
    };
  }, []);

  const acknowledge = useCallback(() => {
    if (version) {
      setPersistedValue(APP_VALUE_KEYS.releaseWelcomeSeenVersion, version);
    }
    setVersion(null);
  }, [version]);

  useEffect(() => {
    if (!version) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") acknowledge();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [acknowledge, version]);

  const openMcpSettings = () => {
    acknowledge();
    onOpenMcpSettings();
  };

  if (!version) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) acknowledge(); }}>
      <DialogContent className="max-w-md overflow-hidden p-0" onClose={acknowledge}>
        <div className="border-b border-border bg-gradient-to-br from-primary/15 via-primary/5 to-transparent px-5 py-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 text-primary">
            <PlugZap className="h-5 w-5" />
          </div>
          <DialogHeader className="pb-0">
            <DialogTitle>Penguin v{version} is ready</DialogTitle>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This release includes the latest Penguin MCP runtime for Claude and Codex.
            </p>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/25 p-3">
            {mcpRefreshState === "refreshing" ? (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : mcpRefreshState === "ready" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            )}
            <div>
              <p className="text-sm font-medium text-foreground">
                {mcpRefreshState === "refreshing"
                  ? "Updating Penguin MCP..."
                  : mcpRefreshState === "ready"
                    ? "Penguin MCP updated"
                    : "MCP setup needs attention"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {mcpRefreshState === "needs-attention"
                  ? "Open MCP Settings to retry or configure an AI client."
                  : "Restart any open Claude or Codex session so it loads this version."}
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={acknowledge}>
              Got it
            </Button>
            <Button size="sm" onClick={openMcpSettings}>
              Open MCP Settings
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
