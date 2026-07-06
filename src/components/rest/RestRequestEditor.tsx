// Simplified layout — matching gRPC client module RequestPanel: Headers + Body sections.
// No tab strip. Just stacked sections like the client.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, Copy, Plus, RotateCcw, Save, Search, Send, Square, X, Braces } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  REST_FOCUS_URL_EVENT,
  REST_SAVE_REQUEST_EVENT,
  REST_SEND_REQUEST_EVENT,
} from "@/lib/rest-events";
import { authToSecretRefs } from "./rest-keychain";
import { RestAuthorizationPanel } from "./RestAuthorizationPanel";
import { buildCurl } from "./rest-curl-builder";
import { applyCurlToRequest } from "./rest-curl-apply";
import { appendHistory } from "./rest-history";
import { generatePenguinRequestId, PENGUIN_REQUEST_ID_HEADER } from "@/lib/penguin-request-id";
import { parseJsonBody } from "@/lib/jsonpath-mini";
import { computeResponseMatches } from "@/lib/response-search";
import { useAppStore } from "@/lib/store";
import type { RestResponseSlot } from "@/lib/store-types";
import { JsonEditor } from "@/components/ui/json-editor";
import type { RestMethod, RestRequestRecord, RestResponse } from "./rest-types";
import { writeClipboard } from "@/lib/clipboard";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";

const METHOD_OPTIONS: { value: RestMethod; label: string }[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
  { value: "HEAD", label: "HEAD" },
  { value: "OPTIONS", label: "OPTIONS" },
];

export interface RestRequestEditorProps {
  request: RestRequestRecord;
  onChange: (next: RestRequestRecord) => void;
  envVars?: Record<string, string>;
}

const DEFAULT_REST_SLOT: RestResponseSlot = {
  response: null, sendError: null, sending: false,
  sendVersion: 0, subTab: "body", showFullBody: false,
};

export function RestRequestEditor({ request, onChange, envVars = {} }: RestRequestEditorProps) {
  const interpolate = (text: string): string =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => envVars[key] ?? "");

  const slot = useAppStore((s): RestResponseSlot => s.restResponses[request.id] ?? DEFAULT_REST_SLOT);
  const { response, sendError, sending } = slot;

  const [savedFlash, setSavedFlash] = useState(false);
  // WHY: collapsed by default to keep the client-module layout — but the
  // section header always shows whether credentials are configured, so auth
  // is never silently injected with zero UI indication.
  const [authOpen, setAuthOpen] = useState(false);
  const [curlCopiedFlash, setCurlCopiedFlash] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [curlPasteFlash, setCurlPasteFlash] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const patch = (p: Partial<RestRequestRecord>) => onChange({ ...request, ...p });

  const requestRef = useRef(request);
  const sendingRef = useRef(sending);
  useEffect(() => { requestRef.current = request; sendingRef.current = sending; }, [request, sending]);

  // ---- Send (same logic as before, just extracted) ----
  const handleSend = async () => {
    const req = requestRef.current;
    if (sendingRef.current || !req.url.trim()) return;
    const rawUrl = interpolate(req.url);
    const sanitizedUrl = rawUrl.trim().replace(/[?}\s]+$/g, "");
    const myVersion = useAppStore.getState().bumpRestSendVersion(req.id);
    useAppStore.getState().setRestResponseResult(req.id, myVersion, null, null);
    useAppStore.getState().setRestSending(req.id, true);
    let resp: RestResponse | null = null;
    let failure = false;
    try {
      const sendHeaders = req.headers.map((h) => ({ ...h, value: interpolate(h.value) }));
      const sendQuery = req.queryParams.map((q) => ({ ...q, value: interpolate(q.value) }));
      const auth = req.auth;
      if (auth) {
        if (auth.kind === "bearer" && auth.tokenHandleId)
          sendHeaders.push({ key: "Authorization", value: "", enabled: true });
        else if (auth.kind === "basic" && auth.passwordHandleId)
          sendHeaders.push({ key: "Authorization", value: "", enabled: true });
        else if (auth.kind === "api-key" && auth.valueHandleId && auth.name.trim()) {
          const row = { key: auth.name.trim(), value: "", enabled: true };
          if (auth.in === "query") sendQuery.push(row);
          else sendHeaders.push(row);
        }
      }
      // Auto-attach x-penguin-id (matches gRPC client behavior)
      const penguinRequestId = generatePenguinRequestId().value;
      sendHeaders.push({ key: PENGUIN_REQUEST_ID_HEADER, value: penguinRequestId, enabled: true });
      const sendBody = req.body
        ? (req.body.mode === "json" || req.body.mode === "raw")
          ? { ...req.body, content: interpolate(req.body.content) }
          : req.body
        : undefined;
      resp = await invoke<RestResponse>("rest_send_request", {
        payload: {
          req: {
            method: req.method, url: sanitizedUrl,
            headers: sendHeaders, queryParams: sendQuery, body: sendBody,
            timeoutMs: req.timeoutMs, followRedirects: req.followRedirects,
          },
          secretRefs: authToSecretRefs(req.auth),
          collectionId: req.collectionId,
        },
      });
      useAppStore.getState().setRestResponseResult(req.id, myVersion, resp, null);
    } catch (error) {
      failure = true;
      useAppStore.getState().setRestResponseResult(
        req.id, myVersion, null,
        error instanceof Error ? error.message : JSON.stringify(error),
      );
    } finally {
      const currentVersion = useAppStore.getState().restResponses[req.id]?.sendVersion ?? 0;
      if (currentVersion === myVersion) {
        // NOTE: sanitizedUrl is send-only — never write the interpolated URL
        // back into the record, or the {{var}} template is destroyed on save.
        appendHistory({
          status: failure ? 0 : resp?.status ?? 0,
          elapsedMs: resp?.elapsedMs ?? 0, bodyBytes: resp?.bodyBytes ?? 0,
          requestName: req.name, collectionId: req.collectionId,
          snapshot: {
            method: req.method, url: req.url,
            headers: req.headers, queryParams: req.queryParams,
            body: req.body, auth: req.auth,
            followRedirects: req.followRedirects, timeoutMs: req.timeoutMs,
          },
        });
      }
    }
  };

  const handleCancel = () => {
    useAppStore.getState().bumpRestSendVersion(request.id);
    useAppStore.getState().setRestSending(request.id, false);
  };

  // WHY: the ⌘↩ document listener registers once ([] deps) and would capture
  // the first render's handleSend — whose `interpolate` closes over the first
  // render's envVars. Latest-ref keeps keyboard sends on current env values.
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // ---- Headers (matching client module style) ----
  const handleAddHeader = () => patch({ headers: [...request.headers, { key: "", value: "", enabled: true }] });
  const handleUpdateHeader = (i: number, p: Partial<typeof request.headers[number]>) =>
    onChange({ ...request, headers: request.headers.map((h, j) => j === i ? { ...h, ...p } : h) });
  const handleRemoveHeader = (i: number) =>
    onChange({ ...request, headers: request.headers.filter((_, j) => j !== i) });

  // ---- Body (JSON/raw editable — matching gRPC client) ----
  const body = request.body;
  const bodyContent =
    body === undefined || body.mode === "none"
      ? "{}"
      : body.mode === "form-urlencoded" || body.mode === "multipart"
        ? // Legacy form bodies (pre-simplification): show the real fields as
          // urlencoded text instead of a fake "{}" that hides them.
          body.fields
            .filter((f) => f.enabled)
            .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
            .join("&")
        : body.content;
  const handleBodyChange = (content: string) =>
    // WHY: keep non-json bodies raw — stamping mode:"json" onto an edited
    // form/raw body would misrepresent what gets sent.
    onChange({
      ...request,
      body: { mode: !request.body || request.body.mode === "json" ? "json" : "raw", content },
    });
  const handleFormatBody = () => {
    try { onChange({ ...request, body: { mode: "json", content: JSON.stringify(JSON.parse(bodyContent), null, 2) } }); }
    catch { /* not JSON */ }
  };

  // ---- Copy curl ----
  const handleCopyCurl = async () => {
    setClipboardError(null);
    try {
      await writeClipboard(await buildCurl(requestRef.current));
      setCurlCopiedFlash(true); window.setTimeout(() => setCurlCopiedFlash(false), 1200);
    } catch (e) {
      setClipboardError(`Clipboard write failed${e instanceof Error ? `: ${e.message}` : ""}`);
      window.setTimeout(() => setClipboardError(null), 3500);
    }
  };

  // ---- Event listeners ----
  useEffect(() => {
    const onSend = () => { void handleSendRef.current(); };
    const onSave = () => { setSavedFlash(true); window.setTimeout(() => setSavedFlash(false), 1200); };
    const onFocusUrl = () => { const el = urlInputRef.current; if (el) { el.focus(); el.select(); } };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sendingRef.current) { e.stopPropagation(); handleCancel(); }
    };
    document.addEventListener(REST_SEND_REQUEST_EVENT, onSend);
    document.addEventListener(REST_SAVE_REQUEST_EVENT, onSave);
    document.addEventListener(REST_FOCUS_URL_EVENT, onFocusUrl);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener(REST_SEND_REQUEST_EVENT, onSend);
      document.removeEventListener(REST_SAVE_REQUEST_EVENT, onSave);
      document.removeEventListener(REST_FOCUS_URL_EVENT, onFocusUrl);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, []);

  // ---- Render ----
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      {/* Name + Save / Copy curl — h-9 aligns with sidebar search bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <Input value={request.name} onChange={(e) => patch({ name: e.target.value })}
          placeholder="Request name"
          className="h-7 max-w-md flex-1 border-transparent bg-transparent text-sm shadow-none hover:border-border focus:border-primary" />
        <Button size="sm" variant="ghost" className={cn("ml-auto h-7 text-xs", savedFlash && "text-emerald-500")}
          onClick={() => { setSavedFlash(true); window.setTimeout(() => setSavedFlash(false), 1200); }}
          title="Save (⌘S)">
          <Save className="mr-1 h-3 w-3" />{savedFlash ? "Saved" : "Save"}
          <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
        </Button>
        <Button size="sm" variant="ghost" className={cn("h-7 text-xs", curlCopiedFlash && "text-emerald-500")}
          onClick={() => { void handleCopyCurl(); }} title="Copy as curl">
          <Copy className="mr-1 h-3 w-3" />{curlCopiedFlash ? "Copied" : "Copy curl"}
        </Button>
        {clipboardError && <span className="text-[10px] text-red-500" title={clipboardError}>⚠ {clipboardError}</span>}
      </div>

      {/* URL bar — h-10 row matching sidebar rhythm */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <Select value={request.method} onChange={(e) => patch({ method: e.target.value as RestMethod })}
          options={METHOD_OPTIONS} className="h-8 w-24 shrink-0 font-mono text-xs font-semibold" />
        <Input ref={urlInputRef} value={request.url} onChange={(e) => patch({ url: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text") ?? "";
            if (!text.trim().toLowerCase().startsWith("curl")) return;
            e.preventDefault();
            void (async () => {
              const result = await applyCurlToRequest(text, request.collectionId);
              if (!result) {
                setCurlPasteFlash("Couldn't parse curl — pasted as URL.");
                window.setTimeout(() => setCurlPasteFlash(null), 2500);
                patch({ url: text }); return;
              }
              onChange({ ...request, ...result.patch });
              const parts = ["Imported curl"];
              if (result.parsedHeaderCount > 0) parts.push(`${result.parsedHeaderCount} header${result.parsedHeaderCount === 1 ? "" : "s"}`);
              if (result.hasBody) parts.push("body");
              if (result.promotedAuth) parts.push("auth (saved to keychain)");
              setCurlPasteFlash(parts.join(" · ")); window.setTimeout(() => setCurlPasteFlash(null), 2500);
            })();
          }}
          placeholder="Enter URL or paste curl" className="h-8 min-w-0 flex-1 font-mono text-sm" />
        {sending ? (
          <Button size="sm" variant="destructive" className="h-8 shrink-0 px-5 text-xs" onClick={handleCancel} title="Cancel request (Esc)">
            <Square className="mr-1 h-3 w-3" />Cancel
          </Button>
        ) : (
          <Button size="sm" className="h-8 shrink-0 px-5 text-xs" onClick={handleSend} disabled={!request.url.trim()} title="Send (⌘↩)">
            <Send className="mr-1 h-3 w-3" />Send
            <ChevronDown className="ml-1 h-3 w-3 opacity-70" />
          </Button>
        )}
      </div>
      {curlPasteFlash && (
        <div className="shrink-0 border-b border-border bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">{curlPasteFlash}</div>
      )}

      {/* Request + Response split — matching client module (50/50 fixed) */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* Left: Request — Headers + Body sections (matching gRPC client RequestPanel exactly) */}
        <div className="flex w-1/2 min-h-0 min-w-0 flex-col overflow-hidden border-r border-border">
          <div className="flex-1 flex flex-col min-h-0 overflow-auto">
            {/* Headers — compact table style */}
            <div className="border-b border-border">
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Headers</span>
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={handleAddHeader}>
                  <Plus className="mr-1 h-3 w-3" />Add
                </Button>
              </div>
              {request.headers.length > 0 && (
                <div className="divide-y divide-border">
                  {request.headers.map((h, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-3 py-1 group">
                      <input type="checkbox" checked={h.enabled}
                        onChange={(e) => handleUpdateHeader(i, { enabled: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-border accent-primary shrink-0" />
                      <input value={h.key}
                        onChange={(e) => handleUpdateHeader(i, { key: e.target.value })}
                        placeholder="Key" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                        className="h-7 flex-1 min-w-0 bg-transparent font-mono text-xs px-1.5 rounded border border-transparent focus:border-border focus:outline-none" />
                      <span className="text-muted-foreground/40 text-xs shrink-0">:</span>
                      <input value={h.value}
                        onChange={(e) => handleUpdateHeader(i, { value: e.target.value })}
                        placeholder="Value" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                        className="h-7 flex-[2] min-w-0 bg-transparent font-mono text-xs px-1.5 rounded border border-transparent focus:border-border focus:outline-none" />
                      <button onClick={() => handleRemoveHeader(i)}
                        className="opacity-0 group-hover:opacity-100 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-destructive/10 transition-opacity">
                        <X className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Authorization — collapsible; restored after the simplify
                refactor orphaned the panel while auth kept being sent */}
            <div className="border-b border-border">
              <button
                type="button"
                onClick={() => setAuthOpen((open) => !open)}
                className="flex w-full items-center justify-between px-3 py-1.5 bg-muted/20"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Authorization
                  {request.auth && request.auth.kind !== "none" && (
                    <span className="ml-1.5 normal-case tracking-normal text-primary">· {request.auth.kind} 已配置</span>
                  )}
                </span>
                {authOpen
                  ? <ChevronUp className="h-3 w-3 opacity-60" />
                  : <ChevronDown className="h-3 w-3 opacity-60" />}
              </button>
              {authOpen && (
                <div className="px-3 py-2">
                  <RestAuthorizationPanel request={request} onChange={onChange} />
                </div>
              )}
            </div>

            {/* Body — JSON only */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20 border-b border-border">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Body</span>
                <div className="flex gap-0.5">
                  <button className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                    onClick={handleFormatBody} title="Format JSON"><Braces className="h-3 w-3" /></button>
                  <button className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                    onClick={() => onChange({ ...request, body: { mode: "json", content: "{}" } })} title="Reset"><RotateCcw className="h-3 w-3" /></button>
                </div>
              </div>
              <div className="flex-1 min-h-0 w-full">
                <JsonEditor value={bodyContent} onChange={handleBodyChange} placeholder='{"key": "value"}' />
              </div>
            </div>
          </div>
        </div>

        {/* Right: Response — fixed 50% width */}
        <div className="flex w-1/2 min-h-0 min-w-0 flex-col overflow-hidden bg-card/10">
          {response ? (
            <ResponsePanel response={response} requestId={request.id} />
          ) : sendError ? (
            <ErrorResponsePanel error={sendError} url={request.url} />
          ) : (
            <ResponseEmptyState sending={sending} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Simplified response panel (matching gRPC client: no sub-tabs, just body) ----
const RESPONSE_DISPLAY_CAP = 1_000_000;

function ResponsePanel({ response }: { response: RestResponse; requestId: string }) {
  const [showFullBody, setShowFullBody] = useState(false);
  const [bodyCopied, setBodyCopied] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);

  useEffect(() => { setShowFullBody(false); }, [response.body]);

  const parsedBody = useMemo(() => parseJsonBody(response.body), [response.body]);
  const prettyDisplay = useMemo(() => {
    if (!parsedBody.ok || parsedBody.parsed === undefined) return response.body;
    try { return JSON.stringify(parsedBody.parsed, null, 2); } catch { return response.body; }
  }, [parsedBody, response.body]);

  const display = !showFullBody && prettyDisplay.length > RESPONSE_DISPLAY_CAP
    ? prettyDisplay.slice(0, RESPONSE_DISPLAY_CAP) : prettyDisplay;
  const isDisplayTruncated = !showFullBody && prettyDisplay.length > RESPONSE_DISPLAY_CAP;

  // Find-in-response — click 🔍 opens search
  const handleToggleSearch = () => {
    const el = bodyContainerRef.current;
    if (el) {
      const view = EditorView.findFromDOM(el);
      if (view) {
        // JSON response: use CodeMirror's built-in search panel
        openSearchPanel(view);
        return;
      }
    }
    // non-JSON response: use our custom search bar with highlighting
    setSearchOpen((o) => !o);
  };

  // Sync our search query to CodeMirror's search panel
  const bodyContainerRef = useRef<HTMLDivElement | null>(null);

  // Find-in-response for non-JSON (<pre>) responses
  const displayLines = useMemo(() => display.split("\n"), [display]);
  const searching = searchOpen && searchQuery.trim().length > 0;
  const searchResult = useMemo(
    () => computeResponseMatches(displayLines, searching ? searchQuery : ""),
    [displayLines, searchQuery, searching],
  );
  const searchMatches = searchResult.flat;
  const searchPerLine = searchResult.perLine;
  useEffect(() => { setActiveMatch(0); }, [searchQuery, display]);
  const goNextMatch = () => setActiveMatch((m) => searchMatches.length ? (m + 1) % searchMatches.length : 0);
  const goPrevMatch = () => setActiveMatch((m) => searchMatches.length ? (m - 1 + searchMatches.length) % searchMatches.length : 0);

  // Highlight & scroll to current match in <pre> element
  const preRef = useRef<HTMLPreElement | null>(null);
  const currentMatch = searchMatches[activeMatch];
  useEffect(() => {
    if (!currentMatch || !preRef.current) return;
    const lineEl = preRef.current.querySelector(`[data-line="${currentMatch.line}"]`);
    if (lineEl) lineEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentMatch]);

  // Build highlighted HTML for <pre> when searching
  const highlightedHtml = useMemo(() => {
    if (!searching || !searchMatches.length) return null;
    const highlightLine = (line: string, lineIdx: number): string => {
      const matchesOnLine = searchPerLine.get(lineIdx);
      if (!matchesOnLine || !matchesOnLine.length) return escapeHtml(line);
      const ranges = [...matchesOnLine].sort((a, b) => a.start - b.start);
      let result = "";
      let pos = 0;
      for (const r of ranges) {
        result += escapeHtml(line.slice(pos, r.start));
        const isActive = r.globalIndex === activeMatch;
        result += `<mark class="${isActive ? "bg-amber-400 text-amber-950 dark:bg-amber-600 dark:text-white" : "bg-amber-500/20 text-inherit"} rounded-sm">${escapeHtml(line.slice(r.start, r.end))}</mark>`;
        pos = r.end;
      }
      result += escapeHtml(line.slice(pos));
      return result;
    };
    return displayLines.map((line, i) =>
      `<span data-line="${i}">${highlightLine(line, i)}</span>`,
    ).join("\n");
  }, [displayLines, searching, searchPerLine, activeMatch]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden border-t border-border bg-background">
      {/* Status row — matching gRPC client ResponsePanel */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className={cn("rounded px-2 py-0.5 font-mono text-[11px] font-semibold", statusPill(response.status))}>
          {response.status > 0 ? `${response.status}${statusText(response.status) ? ` ${statusText(response.status)}` : ""}` : "—"}
        </span>
        <span className="text-[11px] text-muted-foreground">{response.elapsedMs}ms</span>
        <span className="text-[11px] text-muted-foreground">{formatBytes(response.bodyBytes)}</span>
        {response.truncated && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">truncated</span>}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={handleToggleSearch}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", searchOpen && "bg-accent text-accent-foreground")}
            title="Find in response"><Search className="h-3 w-3" /></button>
          <button type="button" onClick={async () => { try { await writeClipboard(response.body); setBodyCopied(true); window.setTimeout(() => setBodyCopied(false), 1200); } catch {} }}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", bodyCopied && "text-emerald-500")}
            title="Copy response body"><Copy className="h-3 w-3" /></button>
        </div>
      </div>
      {/* Find-in-response search bar — matching gRPC client */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-4 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) goPrevMatch(); else goNextMatch(); }
              else if (e.key === "Escape") { e.preventDefault(); setSearchOpen(false); }
            }}
            placeholder="Find in response…" spellCheck={false} autoComplete="off"
            className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-2 text-[11px] outline-none focus:ring-1 focus:ring-primary/40" />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {searchMatches.length ? `${Math.min(activeMatch + 1, searchMatches.length)}/${searchMatches.length}` : searchQuery.trim() ? "0/0" : ""}
          </span>
          <button type="button" onClick={goPrevMatch} disabled={!searchMatches.length}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Previous match (Shift+Enter)"><ChevronUp className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={goNextMatch} disabled={!searchMatches.length}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Next match (Enter)"><ChevronDown className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {/* Response body */}
      <div ref={bodyContainerRef} className="flex flex-1 min-h-0 min-w-0 overflow-hidden p-3">
        <div className="flex w-full min-w-0 max-w-full flex-1 min-h-0 overflow-hidden rounded border border-border/60 bg-background">
          {parsedBody.ok
            ? <JsonEditor value={display} onChange={() => {}} readOnly />
            : highlightedHtml
              ? <pre ref={preRef} className="h-full w-full overflow-auto p-2 font-mono text-[11px] leading-relaxed text-foreground/90" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
              : <pre ref={preRef} className="h-full w-full overflow-auto p-2 font-mono text-[11px] leading-relaxed text-foreground/90">{display}</pre>}
        </div>
      </div>
      {isDisplayTruncated && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
          <span>Showing first {(RESPONSE_DISPLAY_CAP / 1024).toFixed(0)} KB of {formatBytes(prettyDisplay.length)}</span>
          <button type="button" onClick={() => setShowFullBody(true)} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-accent">Show full</button>
        </div>
      )}
    </div>
  );
}

function ResponseEmptyState({ sending }: { sending: boolean }) {
  if (sending) return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="text-xs">Sending request…</p><p className="text-[10px]">Press Esc to cancel</p>
    </div>
  );
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-border"><Copy className="h-5 w-5 opacity-40" /></div>
      <p className="text-sm text-foreground/80">Response will appear here</p>
      <p className="text-[10px]">Fill in the URL and click Send.</p>
    </div>
  );
}

function ErrorResponsePanel({ error, url }: { error: string; url: string }) {
  let kind = "Error", message = error;
  try { const p = JSON.parse(error) as { kind?: string; message?: string }; if (p.kind) kind = p.kind; if (p.message) message = p.message; } catch {}
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-3 py-1.5 text-[11px]">
        <span className="rounded bg-red-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-red-600 dark:text-red-400">{kind.toUpperCase()}</span>
        <span className="text-muted-foreground">Request failed</span>
      </div>
      <div className="space-y-2 p-3">
        <div><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Message</p><p className="mt-1 font-mono text-[11px] text-red-600 dark:text-red-400">{message}</p></div>
        <div><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">URL attempted</p><p className="mt-1 break-all font-mono text-[11px] text-foreground/80">{url || "(empty)"}</p></div>
      </div>
    </div>
  );
}

// ---- Helpers ----
function statusPill(status: number): string {
  if (status === 0) return "bg-muted text-muted-foreground";
  if (status >= 200 && status < 300) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (status >= 300 && status < 400) return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  return "bg-red-500/15 text-red-600 dark:text-red-400";
}
function statusText(status: number): string {
  const m: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable", 429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  return m[status] ?? "";
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
