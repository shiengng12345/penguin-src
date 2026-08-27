import { useAppStore, useActiveTab } from "@/lib/store";
import { SendMascot } from "@/components/common/SendMascot";
import { EnvInput } from "@/components/ui/env-input";
import { Badge } from "@/components/ui/badge";
import { Globe, Server, RotateCcw, Pencil, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn, ensureProtocol } from "@/lib/utils";
import { REST_METHODS, toRestMethod } from "@/lib/rest";
import { computeServicePath, computeConnectServicePath } from "@penguin/core";

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

  // Resolve protocol immediately as soon as the value looks URL-like
  // (contains a dot, no existing protocol, not a {{VAR}} template).
  const maybeEnsureProtocol = (url: string): string => {
    if (tab.protocolTab !== "grpc-web" && tab.protocolTab !== "sdk") return url;
    if (!url.includes(".")) return url;
    return ensureProtocol(url);
  };

  // Wire transport for grpc-web tabs: classic gRPC-Web vs Connect unary.
  // The auto path follows it — gateway-prefixed vs protocol-standard 2-segment.
  const isGrpcWebTab = tab.protocolTab === "grpc-web";
  const activeTransport = isGrpcWebTab ? (tab.transport ?? "grpc-web") : "grpc-web";
  const autoPath = tab.selectedMethod
    ? activeTransport === "connect"
      ? computeConnectServicePath(tab.selectedMethod.fullName)
      : computeServicePath(tab.selectedMethod.fullName)
    : null;
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
        {isGrpcWebTab ? (
          // Per-request wire-transport flip button: one badge-sized control,
          // fixed width for both labels, click swaps gRPC-Web ↔ Connect (old
          // servers speak gRPC-Web, migrated ones speak Connect).
          <button
            type="button"
            onClick={() =>
              updateActiveTab({ transport: activeTransport === "connect" ? "grpc-web" : "connect" })
            }
            title={
              activeTransport === "connect"
                ? "Transport: Connect（新服务）— 点击切换到 gRPC-Web"
                : "Transport: gRPC-Web（旧服务）— 点击切换到 Connect"
            }
            data-tour="transport-toggle"
            className={cn(
              "group flex w-[92px] shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-1.5 py-1 font-mono text-[10px] transition-colors",
              activeTransport === "connect"
                ? "border-primary/60 bg-primary text-primary-foreground hover:bg-primary/85"
                : "border-border bg-transparent text-muted-foreground hover:border-primary/40 hover:bg-accent/40 hover:text-foreground",
            )}
          >
            <ArrowLeftRight className="h-3 w-3 shrink-0 opacity-60 transition-transform duration-200 group-hover:rotate-180 group-hover:opacity-100" />
            {/* key remount replays the swap-in animation on each flip */}
            <span key={activeTransport} className="animate-transport-swap">
              {activeTransport === "connect" ? "CONNECT" : "GRPC-WEB"}
            </span>
          </button>
        ) : (
          <Badge variant="outline" className="shrink-0 font-mono text-[10px] gap-1">
            {isRest ? <Globe className="h-3 w-3" /> : <Server className="h-3 w-3" />}
            {tab.protocolTab.toUpperCase()}
          </Badge>
        )}

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
          onChange={(url) => updateActiveTab({ targetUrl: maybeEnsureProtocol(url) })}
          onBlur={() => {
            if (tab.protocolTab !== "grpc-web" && tab.protocolTab !== "sdk") return;
            const normalized = ensureProtocol(tab.targetUrl);
            if (normalized !== tab.targetUrl) updateActiveTab({ targetUrl: normalized });
          }}
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
          <SendMascot className={cn("mr-1.5 h-6 w-auto", tab.isLoading && "animate-bounce")} />
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
