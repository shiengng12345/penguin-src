import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { useAppStore, useActiveTab, type MetadataEntry, type HistoryEntry, type SavedRequest } from "@/lib/store";
import { useEnvironments } from "@/hooks/useEnvironments";
import { interpolate } from "@/lib/environment-store";
import { logger } from "@/lib/logger";
import { isEmptyAuthHeader } from "@/lib/header-utils";
import { computeServicePath } from "@penguin/core";
import { generatePenguinRequestId, PENGUIN_REQUEST_ID_HEADER } from "@/lib/penguin-request-id";
import { Button } from "@/components/ui/button";
import { Send, Plus, X, RotateCcw, Copy, Braces, Bookmark, Check, FileText, Terminal, Ban, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildRestCurl, REST_BODY_MODES, resolveRestUrl } from "@/lib/rest";
import { writeClipboard } from "@/lib/clipboard";

// Pattern matches any `{{VAR}}` template that survived interpolation —
// signals the active env is missing the variable. Sending such a header
// would leak template syntax to the server, so we drop it and log loud.
const UNRESOLVED_TEMPLATE_PATTERN = /\{\{\s*\w+\s*\}\}/;

const LazyJsonEditor = lazy(() => import("@/components/ui/json-editor").then(m => ({ default: m.JsonEditor })));

export function RequestPanel() {
  const { updateActiveTab, addHistory, saveRequest } = useAppStore();
  const configSynced = useAppStore((s) => s.configSynced);
  const tab = useActiveTab();
  const { activeEnv } = useEnvironments();
  const sendRef = useRef<() => void>(() => {});
  const saveRef = useRef<() => void>(() => {});
  const abortRef = useRef<AbortController | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [curlFlash, setCurlFlash] = useState(false);
  const [offlineFlash, setOfflineFlash] = useState(false);

  useEffect(() => {
    const sendHandler = () => sendRef.current();
    const saveHandler = () => saveRef.current();
    const cancelHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
    document.addEventListener("penguin:send-request", sendHandler);
    document.addEventListener("penguin:save-request", saveHandler);
    document.addEventListener("keydown", cancelHandler);
    return () => {
      document.removeEventListener("penguin:send-request", sendHandler);
      document.removeEventListener("penguin:save-request", saveHandler);
      document.removeEventListener("keydown", cancelHandler);
    };
  }, []);

  if (!tab) return null;

  const isRest = tab.protocolTab === "rest";

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    updateActiveTab({
      isLoading: false,
      response: {
        status: "CANCELLED",
        statusCode: 0,
        body: "",
        headers: {},
        duration: 0,
        error: "Request cancelled",
      },
    });
  };

  const handleSend = async () => {
    if (!tab.targetUrl.trim() || (!isRest && !tab.selectedMethod)) return;
    if (!configSynced) return;

    if (!navigator.onLine) {
      setOfflineFlash(true);
      setTimeout(() => setOfflineFlash(false), 3000);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const resolvedUrl = interpolate(tab.targetUrl, activeEnv);
    updateActiveTab({ isLoading: true, response: null });

    // The tab's own headers are the single source of truth for what gets sent.
    // Default Headers (Settings) only SEED a tab's metadata at creation time
    // (see createTab); we deliberately do NOT re-merge them here, so removing a
    // header from a tab means it is never sent again. Then resolve {{VAR}}
    // templates in each value against the active env so headers like
    // `x-env-tag: {{X_ENV_TAG}}` switch automatically with env.
    const baseMetadata = tab.metadata
      .map((m) => ({ ...m, value: interpolate(m.value, activeEnv) }))
      .filter((m) => {
        if (!m.enabled || m.key.trim() === "") return true;
        // Drop headers whose {{template}} can't be resolved (env missing the
        // variable) — sending `{{X_ENV_TAG}}` literal would break routing.
        if (UNRESOLVED_TEMPLATE_PATTERN.test(m.value)) {
          logger.warn("RequestPanel", "header dropped — unresolved template", {
            key: m.key,
            value: m.value,
            envName: activeEnv?.name ?? "(none)",
          });
          return false;
        }
        // Drop an Authorization header that has no real credential (empty, or a
        // bare "Bearer"): an empty JWT makes the backend reject the whole call,
        // while omitting it lets the request proceed.
        if (isEmptyAuthHeader(m.key, m.value)) {
          logger.warn("RequestPanel", "header dropped — empty Authorization", { key: m.key });
          return false;
        }
        return true;
      });

    // Auto-attach a unique, time-ordered correlation id to every outgoing
    // request. It is NOT in the headers editor (the user never types it) and is
    // echoed back into the response headers below so it can be read after send.
    // Any manually-entered x-penguin-id is replaced by the generated value.
    const penguinRequestId = generatePenguinRequestId().value;
    const mergedMetadata: MetadataEntry[] = [
      ...baseMetadata.filter((m) => m.key.toLowerCase() !== PENGUIN_REQUEST_ID_HEADER),
      { key: PENGUIN_REQUEST_ID_HEADER, value: penguinRequestId, enabled: true },
    ];

    const entry: HistoryEntry = {
      id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      protocol: tab.protocolTab,
      methodFullName: isRest ? tab.restMethod : tab.selectedMethod?.fullName ?? "",
      serviceName: isRest ? "REST" : tab.selectedService ?? "",
      packageName: isRest ? "" : tab.selectedPackage ?? "",
      url: tab.targetUrl,
      metadata: mergedMetadata.filter((m) => m.enabled && m.key),
      requestBody: tab.requestBody,
      restMethod: isRest ? tab.restMethod : undefined,
      restBodyMode: isRest ? tab.restBodyMode : undefined,
      selectedMethod: isRest ? null : tab.selectedMethod,
    };
    addHistory(entry);

    try {
      const protocol = tab.protocolTab;
      let result;

      if (controller.signal.aborted) return;

      if (protocol === "rest") {
        const envVars = Object.fromEntries((activeEnv?.variables ?? []).map((v) => [v.key, v.value]));
        const finalUrl = resolveRestUrl(tab.targetUrl, envVars);
        const { callRest } = await import("@/lib/rest-client");
        result = await callRest({
          method: tab.restMethod,
          url: finalUrl,
          body: tab.requestBody,
          metadata: mergedMetadata,
        });
      } else if (protocol === "grpc-web" && tab.selectedMethod) {
        const servicePath = tab.pathOverride ?? computeServicePath(tab.selectedMethod.fullName);
        const { callGrpcWeb } = await import("@/lib/grpc-web-client");
        result = await callGrpcWeb({
          url: resolvedUrl,
          servicePath,
          body: tab.requestBody,
          metadata: mergedMetadata,
          packageName: tab.selectedPackage ?? undefined,
        }, controller.signal);
      } else if (protocol === "grpc" && tab.selectedMethod) {
        const servicePath = tab.pathOverride ?? computeServicePath(tab.selectedMethod.fullName);
        const { getPackagesDir } = await import("@/lib/package-manager");
        const packagesDir = await getPackagesDir("grpc");
        const { callGrpcNative } = await import("@/lib/grpc-native-client");
        result = await callGrpcNative({
          url: resolvedUrl,
          servicePath,
          body: tab.requestBody,
          metadata: mergedMetadata,
          packagesDir,
        }, controller.signal);
      } else if (tab.selectedMethod) {
        const fullName = tab.selectedMethod.fullName;
        const parts = fullName.split(".");
        const methodName = parts.pop() ?? "";
        const serviceName =
          parts.length > 0 ? parts[parts.length - 1] : fullName;
        const { getPackagesDir } = await import("@/lib/package-manager");
        const packagesDir = await getPackagesDir("sdk");
        const { callSdk } = await import("@/lib/sdk-client");
        result = await callSdk({
          url: resolvedUrl,
          serviceName,
          methodName,
          body: tab.requestBody,
          metadata: mergedMetadata,
          packagesDir,
        }, controller.signal);
      }

      if (controller.signal.aborted) return;
      abortRef.current = null;
      // Echo the correlation id we sent into the response headers so the user
      // can read it in the response HEADERS panel after sending.
      if (result) {
        result.headers = { ...result.headers, [PENGUIN_REQUEST_ID_HEADER]: penguinRequestId };
      }
      updateActiveTab({ response: result, isLoading: false });
      // Archive the full response with the history row.
      if (result) {
        useAppStore.getState().attachHistoryResponse(entry.id, result);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      abortRef.current = null;
      const errorResponse = {
        status: "ERROR",
        statusCode: 0,
        body: "",
        // Surface the correlation id even on failure so it stays readable.
        headers: { [PENGUIN_REQUEST_ID_HEADER]: penguinRequestId },
        duration: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      updateActiveTab({ response: errorResponse, isLoading: false });
      useAppStore.getState().attachHistoryResponse(entry.id, errorResponse);
    }
  };

  const handleAddHeader = () => {
    updateActiveTab({
      metadata: [
        ...tab.metadata,
        { key: "", value: "", enabled: true },
      ],
    });
  };

  const handleUpdateHeader = (index: number, patch: Partial<MetadataEntry>) => {
    const next = [...tab.metadata];
    next[index] = { ...next[index], ...patch };
    updateActiveTab({ metadata: next });
  };

  const handleRemoveHeader = (index: number) => {
    const next = tab.metadata.filter((_, i) => i !== index);
    updateActiveTab({ metadata: next });
  };

  const handleResetBody = async () => {
    if (isRest) {
      updateActiveTab({ requestBody: "{}" });
      return;
    }
    if (tab.selectedMethod?.requestFields) {
      const { generateDefaultJson } = await import("@penguin/core");
      const defaultJson = generateDefaultJson(tab.selectedMethod.requestFields);
      updateActiveTab({
        requestBody: JSON.stringify(defaultJson, null, 2),
      });
    }
  };

  const handleFormatBody = () => {
    try {
      const parsed = JSON.parse(tab.requestBody);
      updateActiveTab({ requestBody: JSON.stringify(parsed, null, 2) });
    } catch {
      // not valid JSON — leave as-is
    }
  };

  const handleCopyBody = () => {
    writeClipboard(tab.requestBody);
  };

  const handleSaveRequest = () => {
    if (!isRest && !tab.selectedMethod) return;
    const methodShort = isRest ? tab.restMethod : tab.selectedMethod?.name ?? "";
    const serviceShort = isRest ? "" : tab.selectedService?.split(".").pop() ?? "";
    const defaultName = isRest
      ? `${tab.restMethod} ${tab.targetUrl}`.trim()
      : serviceShort
        ? `${serviceShort}.${methodShort}`
        : methodShort;

    const entry: SavedRequest = {
      id: `saved_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: defaultName,
      savedAt: Date.now(),
      protocol: tab.protocolTab,
      methodFullName: isRest ? tab.restMethod : tab.selectedMethod?.fullName ?? "",
      serviceName: isRest ? "REST" : tab.selectedService ?? "",
      packageName: isRest ? "" : tab.selectedPackage ?? "",
      url: tab.targetUrl,
      metadata: tab.metadata.filter((m) => m.key),
      requestBody: tab.requestBody,
      restMethod: isRest ? tab.restMethod : undefined,
      restBodyMode: isRest ? tab.restBodyMode : undefined,
      response: tab.response,
      selectedMethod: isRest ? null : tab.selectedMethod,
    };
    saveRequest(entry);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const handleCopyCurl = () => {
    if (!isRest && !tab.selectedMethod) return;

    if (isRest) {
      const envVars = Object.fromEntries((activeEnv?.variables ?? []).map((v) => [v.key, v.value]));
      let restUrl = tab.targetUrl;
      try {
        restUrl = resolveRestUrl(tab.targetUrl, envVars);
      } catch {
        // Keep the user's current URL text if a path-only URL cannot be resolved yet.
      }
      const headers = tab.metadata
        .map((m) => ({ ...m, value: interpolate(m.value, activeEnv) }))
        .filter((m) => !UNRESOLVED_TEMPLATE_PATTERN.test(m.value))
        .filter((m) => !isEmptyAuthHeader(m.key, m.value));
      const curl = buildRestCurl({
        method: tab.restMethod,
        url: restUrl,
        headers,
        body: tab.requestBody,
      });
      writeClipboard(curl);
      setCurlFlash(true);
      setTimeout(() => setCurlFlash(false), 1500);
      return;
    }

    const resolvedUrl = interpolate(tab.targetUrl, activeEnv);
    const selectedMethod = tab.selectedMethod;
    if (!selectedMethod) return;
    const servicePath = tab.pathOverride ?? computeServicePath(selectedMethod.fullName);
    const fullUrl = `${resolvedUrl.replace(/\/$/, "")}${servicePath}`;

    // Mirror the live send path: tab metadata only (no re-merge of defaults),
    // interpolate, drop unresolved templates + empty Authorization.
    const headers = tab.metadata
      .filter((m) => m.enabled && m.key)
      .map((m) => ({ key: m.key, value: interpolate(m.value, activeEnv) }))
      .filter((m) => !UNRESOLVED_TEMPLATE_PATTERN.test(m.value))
      .filter((m) => !isEmptyAuthHeader(m.key, m.value))
      .map((m) => `  -H '${m.key}: ${m.value}'`)
      .join(" \\\n");

    const contentTypeH = `  -H 'Content-Type: application/json'`;
    const allHeaders = headers
      ? `${contentTypeH} \\\n${headers}`
      : contentTypeH;

    let body = "";
    try {
      body = JSON.stringify(JSON.parse(tab.requestBody));
    } catch {
      body = tab.requestBody;
    }

    const curl = `curl -X POST '${fullUrl}' \\\n${allHeaders} \\\n  -d '${body}'`;
    writeClipboard(curl);
    setCurlFlash(true);
    setTimeout(() => setCurlFlash(false), 1500);
  };

  sendRef.current = handleSend;
  saveRef.current = handleSaveRequest;

  const methodInfo =
    tab.selectedMethod && tab.selectedService
      ? `${tab.selectedService.split(".").pop() ?? tab.selectedService}.${tab.selectedMethod.name}`
      : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden border-r border-border" data-tour="request-panel">
      {offlineFlash && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive flex items-center gap-2">
          <span>No internet connection</span>
          <button onClick={() => setOfflineFlash(false)} className="ml-auto text-destructive/60 hover:text-destructive">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {methodInfo && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Method
          </span>
          <span className="font-mono text-xs text-foreground">{methodInfo}</span>
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        {/* Headers — compact table style */}
        <div className="border-b border-border">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Headers
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={handleAddHeader}
            >
              <Plus className="mr-1 h-3 w-3" />
              Add
            </Button>
          </div>
          {tab.metadata.length > 0 && (
            <div className="divide-y divide-border">
              {tab.metadata.map((entry, i) => (
                <div key={i} className="flex items-center gap-1.5 px-3 py-1 group">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(e) =>
                      handleUpdateHeader(i, { enabled: e.target.checked })
                    }
                    className="h-3.5 w-3.5 rounded border-border accent-primary shrink-0"
                  />
                  <input
                    value={entry.key}
                    onChange={(e) =>
                      handleUpdateHeader(i, { key: e.target.value })
                    }
                    placeholder="Key"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="h-7 flex-1 min-w-0 bg-transparent font-mono text-xs px-1.5 rounded border border-transparent focus:border-border focus:outline-none"
                  />
                  <span className="text-muted-foreground/40 text-xs shrink-0">:</span>
                  <input
                    value={entry.value}
                    onChange={(e) =>
                      handleUpdateHeader(i, { value: e.target.value })
                    }
                    placeholder="Value"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="h-7 flex-[2] min-w-0 bg-transparent font-mono text-xs px-1.5 rounded border border-transparent focus:border-border focus:outline-none"
                  />
                  <button
                    className="opacity-0 group-hover:opacity-100 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-destructive/10 transition-opacity"
                    onClick={() => handleRemoveHeader(i)}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Body
              </span>
              {isRest && (
                <div className="flex items-center gap-1">
                  {REST_BODY_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => updateActiveTab({ restBodyMode: mode })}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                        tab.restBodyMode === mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-0.5">
              <button
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                onClick={handleFormatBody}
                title="Format JSON"
              >
                <Braces className="h-3 w-3" />
              </button>
              <button
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                onClick={handleResetBody}
                title="Reset to default"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
              <button
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                onClick={handleCopyBody}
                title="Copy"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>
          {isRest && tab.restBodyMode === "raw" ? (
            <textarea
              value={tab.requestBody}
              onChange={(e) => updateActiveTab({ requestBody: e.target.value })}
              className="flex-1 w-full resize-none bg-transparent p-3 font-mono text-xs focus:outline-none"
              spellCheck={false}
            />
          ) : (
            <Suspense fallback={
              <textarea
                value={tab.requestBody}
                onChange={(e) => updateActiveTab({ requestBody: e.target.value })}
                className="flex-1 w-full bg-transparent font-mono text-xs p-3 resize-none focus:outline-none"
                spellCheck={false}
              />
            }>
              <LazyJsonEditor
                value={tab.requestBody}
                onChange={(val) => updateActiveTab({ requestBody: val })}
                fields={tab.selectedMethod?.requestFields}
              />
            </Suspense>
          )}
        </div>
      </div>

      <div className="border-t border-border px-3 py-2 flex gap-1.5">
        {tab.isLoading ? (
          <Button
            onClick={handleCancel}
            variant="destructive"
            className="flex-1 h-8"
            size="sm"
          >
            <Ban className="mr-1.5 h-3.5 w-3.5" />
            Cancel (Esc)
          </Button>
        ) : (
          <Button
            onClick={handleSend}
            disabled={(!isRest && !tab.selectedMethod) || !configSynced}
            title={!configSynced ? "Loading environment variables…" : undefined}
            className="flex-1 h-8"
            size="sm"
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {configSynced ? "Send" : "Loading…"}
          </Button>
        )}
        <Button
          variant={savedFlash ? "default" : "outline"}
          size="sm"
          className={cn(
            "h-8 transition-all",
            savedFlash ? "px-3 bg-success text-success-foreground hover:bg-success" : "px-2.5"
          )}
          onClick={handleSaveRequest}
          disabled={!isRest && !tab.selectedMethod}
          title="Save request ⌘ + Shift + S (⌘ + O to open)"
          data-tour="save-btn"
        >
          {savedFlash ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" />
              <span className="text-xs">Saved!</span>
            </>
          ) : (
            <Bookmark className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant={curlFlash ? "default" : "outline"}
          size="sm"
          className={cn(
            "h-8 transition-all",
            curlFlash ? "px-3 bg-success text-success-foreground hover:bg-success" : "px-2.5"
          )}
          onClick={handleCopyCurl}
          disabled={!isRest && !tab.selectedMethod}
          title="Copy as cURL"
          data-tour="curl-btn"
        >
          {curlFlash ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" />
              <span className="text-xs">cURL</span>
            </>
          ) : (
            <Terminal className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2.5"
          onClick={() => document.dispatchEvent(new CustomEvent("penguin:open-proto"))}
          disabled={!tab.selectedMethod}
          title="View Proto ⌘ + P"
        >
          <Code2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2.5"
          onClick={() => document.dispatchEvent(new CustomEvent("penguin:open-doc"))}
          disabled={!tab.selectedMethod}
          title="Request as Doc ⌘ + D"
        >
          <FileText className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
