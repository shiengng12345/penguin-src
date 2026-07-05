import { useAppStore, useActiveTab } from "@/lib/store";
import { EnvInput } from "@/components/ui/env-input";
import { Badge } from "@/components/ui/badge";
import { Send, Globe, Server, RotateCcw, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { REST_METHODS, toRestMethod } from "@/lib/rest";
import { computeServicePath } from "@penguin/core";

interface UrlBarProps {
  resolvedUrl: string | null;
}

const REST_METHOD_OPTIONS = REST_METHODS.map((method) => ({
  value: method,
  label: method,
}));

export function UrlBar({ resolvedUrl }: UrlBarProps) {
  const { updateActiveTab } = useAppStore();
  const tab = useActiveTab();

  if (!tab) return null;

  const autoPath = tab.selectedMethod ? computeServicePath(tab.selectedMethod.fullName) : null;
  const effectivePath = tab.pathOverride ?? autoPath;
  const isOverridden = tab.pathOverride !== null;
  const displayUrl = resolvedUrl ?? tab.targetUrl;
  const isRest = tab.protocolTab === "rest";

  const handlePathChange = (value: string) => {
    const newOverride = value === "" || value === autoPath ? null : value;
    updateActiveTab({ pathOverride: newOverride });
  };

  return (
    <div className="relative z-30 border-b border-border bg-card" data-tour="url-bar">
      {/* Base URL row */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Badge variant="outline" className="shrink-0 font-mono text-[10px] gap-1">
          {tab.protocolTab === "grpc-web" || isRest ? (
            <Globe className="h-3 w-3" />
          ) : (
            <Server className="h-3 w-3" />
          )}
          {tab.protocolTab.toUpperCase()}
        </Badge>

        {isRest && (
          <Select
            value={tab.restMethod}
            onChange={(e) => updateActiveTab({ restMethod: toRestMethod(e.target.value, tab.restMethod) })}
            options={REST_METHOD_OPTIONS}
            className="w-32 shrink-0 font-mono"
          />
        )}

        <EnvInput
          value={tab.targetUrl}
          onChange={(url) => updateActiveTab({ targetUrl: url })}
          placeholder={isRest
            ? "https://api.example.com/v1/users or {{URL}}/v1/users"
            : "Enter URL — e.g. {{ URL }} or http://localhost:8080"}
          className="flex-1"
        />

        <Button
          onClick={() => document.dispatchEvent(new CustomEvent("penguin:send-request"))}
          disabled={tab.isLoading || !tab.targetUrl.trim() || (!isRest && !tab.selectedMethod)}
          size="default"
          data-tour="send-btn"
        >
          <Send className="mr-1.5 h-4 w-4" />
          {tab.isLoading ? "Sending..." : "Send"}
        </Button>
      </div>

      {/* Path row — always-on editable input */}
      {!isRest && autoPath && (
        <div className="flex items-center gap-1.5 px-4 pb-2 -mt-0.5 min-w-0">
          <span className="text-[10px] text-muted-foreground shrink-0">POST</span>
          <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0 truncate max-w-[200px]">
            {displayUrl.replace(/\/$/, "")}
          </span>
          <div className={cn(
            "flex items-center flex-1 min-w-0 rounded px-1.5 py-0.5 border gap-1",
            "bg-muted/20 transition-colors",
            isOverridden
              ? "border-amber-400/50 hover:border-amber-400"
              : "border-border/50 hover:border-border focus-within:border-primary/60"
          )}>
            <Pencil className={cn(
              "h-2.5 w-2.5 shrink-0",
              isOverridden ? "text-amber-400/70" : "text-muted-foreground/50"
            )} />
            <input
              className={cn(
                "font-mono text-[10px] bg-transparent focus:outline-none flex-1 min-w-0",
                isOverridden ? "text-amber-400" : "text-primary"
              )}
              value={effectivePath ?? ""}
              onChange={(e) => handlePathChange(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
            {isOverridden && (
              <button
                onClick={() => updateActiveTab({ pathOverride: null })}
                className="shrink-0 text-muted-foreground/60 hover:text-foreground"
                title="Reset to auto-generated path"
              >
                <RotateCcw className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Method info row */}
      {!isRest && tab.selectedMethod && (
        <div className="flex items-center gap-2 px-4 pb-2 -mt-0.5">
          <span className="text-[10px] text-muted-foreground">Method:</span>
          <span className="font-mono text-[10px] text-foreground">
            {tab.selectedMethod.fullName}
          </span>
          <span className="text-[10px] text-muted-foreground">
            ({tab.selectedMethod.requestType} → {tab.selectedMethod.responseType})
          </span>
        </div>
      )}
    </div>
  );
}
