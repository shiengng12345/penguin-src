import { useMemo, useRef, useState, useCallback, useEffect, type ReactNode } from "react";
import { useActiveTab } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy, Clock, AlertCircle, CheckCircle2, Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { isLightAppTheme } from "@/lib/theme";
import { formatGrpcStatusBadgeLabel, summarizeGrpcStatusResponse } from "@/lib/grpc-status";
import { cn } from "@/lib/utils";
import { writeClipboard } from "@/lib/clipboard";
import { computeResponseMatches, type ResponseLineMatch } from "@/lib/response-search";
import { elideLargeStrings, capRawBody } from "@/lib/response-body-format";

function stripUnderscoreKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripUnderscoreKeys);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      if (!key.startsWith("_")) {
        out[key] = stripUnderscoreKeys((obj as Record<string, unknown>)[key]);
      }
    }
    return out;
  }
  return obj;
}

function unwrapNestedJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(unwrapNestedJson);
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return unwrapNestedJson(JSON.parse(trimmed));
      } catch { /* not valid JSON */ }
    }
    return obj;
  }
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = unwrapNestedJson(v);
    }
    return out;
  }
  return obj;
}

function formatBody(body: string | undefined, stripInternalKeys = true): string {
  if (!body) return "(empty)";
  try {
    const parsed = JSON.parse(body);
    const unwrapped = unwrapNestedJson(parsed);
    const cleaned = stripInternalKeys ? stripUnderscoreKeys(unwrapped) : unwrapped;
    // Elide blob-sized string values (e.g. a gRPC bytes/image field arriving as
    // one ~500KB base64 line) so the pretty view stays readable and doesn't
    // freeze on a single giant line. REST's "raw" view keeps the full body.
    return JSON.stringify(elideLargeStrings(cleaned), null, 2);
  } catch {
    // Non-JSON body (raw text/binary): cap it so a huge blob can't garble the
    // syntax tokenizer / freeze on one giant line.
    return capRawBody(body);
  }
}

type TokenType = "key" | "string" | "number" | "bool" | "null" | "punct";

interface JsonToken {
  text: string;
  type: TokenType;
}

function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const re = /("(?:[^"\\]|\\.)*")\s*(?=:)|("(?:[^"\\]|\\.)*")|(true|false)|(null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\]:,])|(\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(json)) !== null) {
    if (match[1]) tokens.push({ text: match[1], type: "key" });
    else if (match[2]) tokens.push({ text: match[2], type: "string" });
    else if (match[3]) tokens.push({ text: match[3], type: "bool" });
    else if (match[4]) tokens.push({ text: match[4], type: "null" });
    else if (match[5]) tokens.push({ text: match[5], type: "number" });
    else if (match[6]) tokens.push({ text: match[6], type: "punct" });
    else if (match[7]) tokens.push({ text: match[7], type: "punct" });
  }
  return tokens;
}

const TOKEN_CLASSES: Record<TokenType, string> = {
  key: "text-sky-300",
  string: "text-green-300",
  number: "text-rose-300",
  bool: "text-violet-300",
  null: "text-slate-400",
  punct: "text-slate-500",
};

const TOKEN_CLASSES_LIGHT: Record<TokenType, string> = {
  key: "text-sky-700",
  string: "text-green-700",
  number: "text-rose-600",
  bool: "text-violet-600",
  null: "text-slate-500",
  punct: "text-slate-400",
};

function SyntaxJson({ json, className }: { json: string; className?: string }) {
  const tokens = useMemo(() => tokenizeJson(json), [json]);
  const isDark = typeof document !== "undefined"
    ? !isLightAppTheme(document.documentElement.getAttribute("data-theme"))
    : true;
  const colors = isDark ? TOKEN_CLASSES : TOKEN_CLASSES_LIGHT;

  if (tokens.length === 0 && json.length > 0) {
    return (
      <pre className={cn("min-w-max whitespace-pre font-mono text-[11px] leading-5", className)}>
        {json}
      </pre>
    );
  }

  return (
    <pre className={cn("min-w-max whitespace-pre font-mono text-[11px] leading-5", className)}>
      {tokens.map((t, i) => (
        <span key={i} className={colors[t.type]}>{t.text}</span>
      ))}
    </pre>
  );
}

const VIRTUAL_THRESHOLD = 500;
const LINE_HEIGHT = 18;
const OVERSCAN = 20;

function VirtualizedJson({ json }: { json: string }) {
  const lines = useMemo(() => json.split("\n"), [json]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(600);

  const isDark =
    typeof document !== "undefined"
      ? !isLightAppTheme(document.documentElement.getAttribute("data-theme"))
      : true;
  const colors = isDark ? TOKEN_CLASSES : TOKEN_CLASSES_LIGHT;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerH(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  const totalHeight = lines.length * LINE_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerH / LINE_HEIGHT) +OVERSCAN * 2;
  const endIdx = Math.min(lines.length, startIdx +visibleCount);

  const tokenizedLines = useMemo(() => {
    const result: { idx: number; tokens: JsonToken[] }[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push({ idx: i, tokens: tokenizeJson(lines[i]) });
    }
    return result;
  }, [lines, startIdx, endIdx]);

  return (
    <div
      ref={containerRef}
      data-response-code-surface
      className="flex-1 overflow-auto bg-background/95 text-foreground"
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          className="p-3 font-mono text-[11px]"
          style={{
            position: "absolute",
            top: startIdx * LINE_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {tokenizedLines.map(({ idx, tokens }) => (
            <div
              key={idx}
              style={{ height: LINE_HEIGHT }}
              className="min-w-max whitespace-pre leading-[18px]"
            >
              {tokens.length === 0
                ? lines[idx]
                : tokens.map((t, j) => (
                    <span key={j} className={colors[t.type]}>{t.text}</span>
                  ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Find-in-response support ---------------------------------------
// Match-finding lives in lib/response-search (pure + unit-tested). Here we
// only render: matches are highlighted with <mark> over the syntax-colored
// tokens, and the active match can be stepped through / scrolled into view.

const ACTIVE_MATCH_CLASS = "bg-amber-400 text-black rounded-sm";

function HighlightedLine({
  text,
  ranges,
  activeMatch,
  colors,
}: {
  text: string;
  ranges: ResponseLineMatch[] | undefined;
  activeMatch: number;
  colors: Record<TokenType, string>;
}) {
  const hasMatches = ranges !== undefined && ranges.length > 0;
  const tokens = tokenizeJson(text);

  // Non-JSON / empty line (e.g. "(empty)" or a raw REST body): plain
  // text, highlight matches only.
  if (tokens.length === 0) {
    if (!hasMatches) return <>{text}</>;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    ranges!.forEach((r, i) => {
      if (r.start > cursor) nodes.push(text.slice(cursor, r.start));
      nodes.push(
        <span
          key={i}
          className={r.globalIndex === activeMatch ? ACTIVE_MATCH_CLASS : "bg-amber-300/40 rounded-sm"}
        >
          {text.slice(r.start, r.end)}
        </span>,
      );
      cursor = r.end;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
  }

  // JSON line: keep the syntax colors and overlay the match highlight on
  // the overlapping slices, so the body stays fully colored while
  // searching. The active match drops the token color for max contrast
  // on the solid amber; other matches keep their color under a
  // translucent amber wash.
  const out: ReactNode[] = [];
  let offset = 0;
  let key = 0;
  for (const tok of tokens) {
    const tStart = offset;
    const tEnd = offset + tok.text.length;
    offset = tEnd;
    const color = colors[tok.type];
    const overlaps = hasMatches ? ranges!.filter((r) => r.start < tEnd && r.end > tStart) : [];
    if (overlaps.length === 0) {
      out.push(<span key={key++} className={color}>{tok.text}</span>);
      continue;
    }
    let cur = tStart;
    for (const r of overlaps) {
      const mStart = Math.max(r.start, tStart);
      const mEnd = Math.min(r.end, tEnd);
      if (mStart > cur) out.push(<span key={key++} className={color}>{text.slice(cur, mStart)}</span>);
      out.push(
        <span
          key={key++}
          className={
            r.globalIndex === activeMatch
              ? ACTIVE_MATCH_CLASS
              : cn(color, "bg-amber-300/40 rounded-sm")
          }
        >
          {text.slice(mStart, mEnd)}
        </span>,
      );
      cur = mEnd;
    }
    if (cur < tEnd) out.push(<span key={key++} className={color}>{text.slice(cur, tEnd)}</span>);
  }
  return <>{out}</>;
}

// Renders the body as highlighted plain text, reusing the same windowing
// as VirtualizedJson so a large body stays cheap while searching. The
// active match is scrolled into view whenever it changes.
function HighlightedBody({
  lines,
  perLine,
  flat,
  activeMatch,
}: {
  lines: string[];
  perLine: Map<number, ResponseLineMatch[]>;
  flat: { line: number }[];
  activeMatch: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(600);

  const isDark =
    typeof document !== "undefined"
      ? !isLightAppTheme(document.documentElement.getAttribute("data-theme"))
      : true;
  const colors = isDark ? TOKEN_CLASSES : TOKEN_CLASSES_LIGHT;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerH(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  const activeLine = flat[activeMatch]?.line;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || activeLine === undefined) return;
    const top = activeLine * LINE_HEIGHT;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    if (top < viewTop + LINE_HEIGHT || top > viewBottom - LINE_HEIGHT * 2) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [activeMatch, activeLine]);

  const totalHeight = lines.length * LINE_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerH / LINE_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(lines.length, startIdx + visibleCount);

  const visibleLines: number[] = [];
  for (let i = startIdx; i < endIdx; i++) visibleLines.push(i);

  return (
    <div
      ref={containerRef}
      data-response-code-surface
      className="flex-1 overflow-auto bg-background/95 text-foreground"
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          className="p-3 font-mono text-[11px]"
          style={{ position: "absolute", top: startIdx * LINE_HEIGHT, left: 0, right: 0 }}
        >
          {visibleLines.map((idx) => (
            <div
              key={idx}
              style={{ height: LINE_HEIGHT }}
              className="min-w-max whitespace-pre leading-[18px]"
            >
              <HighlightedLine text={lines[idx]} ranges={perLine.get(idx)} activeMatch={activeMatch} colors={colors} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type ResponseView = "pretty" | "raw" | "headers";

// How long the floating "Copied" toast stays up after a header is copied.
const COPIED_FEEDBACK_MS = 1500;
const COMPACT_GRPC_HEADERS = new Set([
  "x-penguin-http-status",
  "x-penguin-http-version",
  "x-penguin-id",
]);

export function ResponsePanel() {
  const tab = useActiveTab();
  const [responseView, setResponseView] = useState<ResponseView>("pretty");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [showAllHeaders, setShowAllHeaders] = useState(false);
  const [copyToast, setCopyToast] = useState<{ x: number; y: number; nonce: number } | null>(null);

  // Click-to-copy for response header values (mirrors the Vault copy UX): copy
  // the value, then pop a small "Copied" toast at the click position. The row
  // value itself is left untouched.
  const handleCopyHeader = useCallback((payload: { value: string; x: number; y: number }): void => {
    void writeClipboard(payload.value);
    setCopyToast({ x: payload.x, y: payload.y, nonce: Date.now() });
  }, []);

  useEffect(() => {
    const noToast = copyToast === null;
    // Nothing showing — no dismiss timer needed.
    if (noToast) return;
    const timer = window.setTimeout(() => setCopyToast(null), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyToast]);

  // Memoized on the response object: parse+unwrap+stringify of a large body
  // must not re-run on unrelated tab re-renders (e.g. request-body keystrokes).
  const response = tab?.response ?? null;
  const isRest = tab?.protocolTab === "rest";
  const responseHeaders = response ? Object.entries(response.headers) : [];
  const compactHeaders = responseHeaders.filter(([key]) => COMPACT_GRPC_HEADERS.has(key.toLowerCase()));
  const hiddenHeaderCount = responseHeaders.length - compactHeaders.length;
  const visibleHeaders = showAllHeaders ? responseHeaders : compactHeaders;

  const bodyJson = useMemo(() => {
    if (!response) return "(empty)";
    const rawBody = response.body;
    const hasBody = rawBody && rawBody !== "" && rawBody !== "{}" && rawBody !== "null";
    if (hasBody) return formatBody(rawBody, !isRest);
    if (response.error) {
      try {
        const parsed = JSON.parse(response.error);
        const unwrapped = unwrapNestedJson(parsed);
        const cleaned = stripUnderscoreKeys(unwrapped);
        return JSON.stringify(cleaned, null, 2);
      } catch {
        return JSON.stringify({
          error: response.error,
          status: response.statusCode || response.status,
        }, null, 2);
      }
    }
    return "(empty)";
  }, [response, isRest]);

  const headerText = useMemo(() => {
    if (!response) return "(none)";
    return Object.keys(response.headers).length > 0
      ? Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")
      : "(none)";
  }, [response]);

  const rawText = response ? (response.body || response.error || "(empty)") : "(empty)";
  const activeBody = isRest && responseView === "raw"
    ? rawText
    : isRest && responseView === "headers"
      ? headerText
      : bodyJson;
  // Splitting a multi-MB body is per-render work worth caching; the line
  // array is reused by the virtual scroller, the line counter, and search.
  const bodyLineArr = useMemo(() => activeBody.split("\n"), [activeBody]);
  const bodyLines = bodyLineArr.length;

  // Find-in-response: only active when the bar is open AND there's a query.
  const searching = searchOpen && searchQuery.trim().length > 0;
  const { flat: searchMatches, perLine: searchPerLine } = useMemo(
    () => computeResponseMatches(bodyLineArr, searching ? searchQuery : ""),
    [bodyLineArr, searchQuery, searching],
  );
  // Reset the active match to the first hit whenever the query or the
  // underlying body changes (new response, switched raw/pretty view).
  useEffect(() => {
    setActiveMatch(0);
  }, [searchQuery, activeBody]);

  const goNextMatch = useCallback(() => {
    setActiveMatch((m) => (searchMatches.length ? (m + 1) % searchMatches.length : 0));
  }, [searchMatches.length]);
  const goPrevMatch = useCallback(() => {
    setActiveMatch((m) =>
      searchMatches.length ? (m - 1 + searchMatches.length) % searchMatches.length : 0,
    );
  }, [searchMatches.length]);

  if (!tab) return null;

  if (tab.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="text-center space-y-1">
          <p className="text-xs">Sending request...</p>
          <p className="text-xs">发送请求中...</p>
          <p className="text-[10px] text-muted-foreground/50 mt-2">Press Esc to cancel</p>
        </div>
      </div>
    );
  }

  if (!tab.response) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground px-6">
        <div className="h-12 w-12 rounded-full border-2 border-dashed border-border flex items-center justify-center">
          <Copy className="h-5 w-5 opacity-30" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-sm font-medium">Response will appear here</p>
          <p className="text-sm">响应将显示在此处</p>
        </div>
        <p className="text-xs text-muted-foreground/50 text-center max-w-xs">
          Select a method, fill in the request, and click Send.
        </p>
      </div>
    );
  }

  const grpcStatusSummary = !isRest ? summarizeGrpcStatusResponse(tab.response) : null;
  const isError = tab.response.status === "ERROR" ||
    (!!tab.response.error && tab.response.status !== "OK") ||
    !!grpcStatusSummary ||
    (isRest && tab.response.statusCode >= 400);
  const statusLabel = formatGrpcStatusBadgeLabel(grpcStatusSummary) ??
    `${tab.response.status}${tab.response.statusCode > 0 ? ` ${tab.response.statusCode}` : ""}`;

  const handleCopy = () => {
    writeClipboard(activeBody);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 bg-card">
        <div className="flex items-center gap-1.5">
          {isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          )}
          <Badge variant={isError ? "destructive" : "success"} className="text-[10px]">
            {statusLabel}
          </Badge>
        </div>

        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          {tab.response.duration}ms
        </div>
      </div>

      {grpcStatusSummary && (
        <div className="border-b border-border bg-destructive/5 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Error details
            </span>
            <Badge variant="destructive" className="text-[10px]">
              {grpcStatusSummary.title}
            </Badge>
            {grpcStatusSummary.transport && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {grpcStatusSummary.transport}
              </span>
            )}
            {grpcStatusSummary.retryable && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Retryable
              </Badge>
            )}
          </div>
          <div className="mt-2 space-y-1 text-xs leading-relaxed">
            <p className="text-foreground">{grpcStatusSummary.explanation}</p>
            <p className="text-muted-foreground">{grpcStatusSummary.hint}</p>
          </div>
        </div>
      )}

      {/* Response headers */}
      {!isRest && Object.keys(tab.response.headers).length > 0 && (
        <div className="border-b border-border bg-card/95 px-4 py-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Headers
            </div>
            {hiddenHeaderCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllHeaders((expanded) => !expanded)}
                className="shrink-0 text-[10px] text-primary hover:underline"
              >
                {showAllHeaders ? "Hide extra headers" : `Show all headers (${responseHeaders.length})`}
              </button>
            )}
          </div>
          <div className="grid gap-y-1">
            {visibleHeaders.map(([key, value]) => (
              <button
                key={key}
                type="button"
                onClick={(e) => handleCopyHeader({ value, x: e.clientX, y: e.clientY })}
                title="Click to copy / 点击复制"
                className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-3 rounded px-1 py-0.5 text-left font-mono text-[11px] transition-colors hover:bg-muted/60"
              >
                <span className="whitespace-nowrap text-primary">{key}:</span>
                <span className="truncate text-muted-foreground" title={value}>{value}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Copied toast — pops at the click position; mirrors the Vault copy UX. */}
      {copyToast !== null ? (
        <div
          key={copyToast.nonce}
          className="pointer-events-none fixed z-50 select-none rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white shadow-lg"
          style={{ left: copyToast.x + 12, top: copyToast.y - 28 }}
        >
          ✓ Copied
        </div>
      ) : null}

      {/* Response body */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          {isRest ? (
            <div className="flex items-center gap-1">
              {(["pretty", "raw", "headers"] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => setResponseView(view)}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-medium uppercase transition-colors",
                    responseView === view
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {view}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Body
            </span>
          )}
          {bodyLines > VIRTUAL_THRESHOLD && (
            <span className="text-[9px] text-muted-foreground/60 font-mono">
              {bodyLines.toLocaleString()} lines (virtual scroll)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-5 px-1.5 text-[10px]", searchOpen && "bg-accent text-accent-foreground")}
            onClick={() => setSearchOpen((o) => !o)}
            title="Find in response"
            aria-label="Find in response"
          >
            <Search className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={handleCopy}>
            <Copy className="mr-1 h-3 w-3" />
            Copy
          </Button>
        </div>
      </div>
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-4 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) goPrevMatch();
                else goNextMatch();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
              }
            }}
            placeholder="Find in response…"
            spellCheck={false}
            autoComplete="off"
            className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-2 text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {searchMatches.length
              ? `${Math.min(activeMatch + 1, searchMatches.length)}/${searchMatches.length}`
              : searchQuery.trim()
                ? "0/0"
                : ""}
          </span>
          <button
            type="button"
            onClick={goPrevMatch}
            disabled={!searchMatches.length}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={goNextMatch}
            disabled={!searchMatches.length}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {searching ? (
        <HighlightedBody
          lines={bodyLineArr}
          perLine={searchPerLine}
          flat={searchMatches}
          activeMatch={activeMatch}
        />
      ) : bodyLines > VIRTUAL_THRESHOLD ? (
        <VirtualizedJson json={activeBody} />
      ) : (
        <div data-response-code-surface className="flex-1 overflow-auto bg-background/95 text-foreground">
          <div className="min-w-max p-3">
            <SyntaxJson json={activeBody} />
          </div>
        </div>
      )}
    </div>
  );
}
