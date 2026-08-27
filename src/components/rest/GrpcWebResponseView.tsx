// Proto response lens for the REST module: gRPC-Web, bare proto (Connect
// unary and friends), and Connect streaming. When a response carries one of
// those content-types, this renders it far better than a raw byte dump:
// HTTP + protocol status, each protobuf message as an honest schema-less
// field-number view, the trailers/end-stream, and a raw hex fallback.
// Named-field decoding (via installed descriptors) is a separate, later
// path — this view never invents field names.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  parseGrpcWebFrames,
  parseGrpcTrailers,
  decodeUnknownMessage,
  bytesToHex,
  GrpcWebParseError,
  CONNECT_END_STREAM_FLAG,
  parseConnectEndStream,
  classifyProtoResponse,
  type ConnectEndStream,
  type ProtoResponseKind,
  type GrpcWebFrame,
  type GrpcTrailer,
  type WireField,
  type WireView,
} from "@penguin/core";
import { cn } from "@/lib/utils";
import { writeClipboard } from "@/lib/clipboard";
import type { RestResponse } from "./rest-types";

// gRPC status code → canonical name (includes 0 = OK, which the app's generic
// status summarizer deliberately hides — the lens must show it).
const GRPC_STATUS_NAME: Record<number, string> = {
  0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND", 6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION", 10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED",
  13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
};
const statusName = (code: number): string => GRPC_STATUS_NAME[code] ?? `CODE_${code}`;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function lensHeader(response: RestResponse, key: string): string | undefined {
  return response.headers.find((h) => h.key.toLowerCase() === key)?.value;
}

/** Which proto protocol a response speaks — see classifyProtoResponse in core. */
export type ProtoLensProtocol = ProtoResponseKind;

export function protoLensProtocol(response: RestResponse): ProtoLensProtocol | null {
  return classifyProtoResponse(lensHeader(response, "content-type"), response.status);
}

/** Any response this lens can decode (gRPC-Web, bare proto, or Connect stream). */
export function isProtoLensResponse(response: RestResponse): boolean {
  return protoLensProtocol(response) !== null;
}

interface DecodedGrpcWeb {
  protocol: ProtoLensProtocol;
  malformed: string | null;
  frames: GrpcWebFrame[];
  messages: WireView[];
  trailer: GrpcTrailer | null;
  endStream: ConnectEndStream | null;
  bytes: Uint8Array;
}

function decode(response: RestResponse): DecodedGrpcWeb {
  const protocol = protoLensProtocol(response) ?? "grpc-web";
  const bytes =
    response.bodyEncoding === "base64"
      ? base64ToBytes(response.body)
      : new TextEncoder().encode(response.body);
  try {
    if (protocol === "proto-unary") {
      // The whole body is one un-framed message; empty bytes are a valid
      // empty message and render as {}.
      return {
        protocol,
        malformed: null,
        frames: [],
        messages: [decodeUnknownMessage(bytes)],
        trailer: null,
        endStream: null,
        bytes,
      };
    }
    const frames = parseGrpcWebFrames(bytes);
    if (protocol === "connect-stream") {
      const endFrame = frames.find((f) => (f.flag & CONNECT_END_STREAM_FLAG) !== 0);
      const messages = frames
        .filter((f) => (f.flag & CONNECT_END_STREAM_FLAG) === 0 && !f.trailer)
        .map((f) => decodeUnknownMessage(f.data));
      return {
        protocol,
        malformed: null,
        frames,
        messages,
        trailer: null,
        endStream: endFrame ? parseConnectEndStream(endFrame.data) : null,
        bytes,
      };
    }
    const messages = frames
      .filter((f) => !f.trailer)
      .map((f) => decodeUnknownMessage(f.data));
    return { protocol, malformed: null, frames, messages, trailer: parseGrpcTrailers(frames), endStream: null, bytes };
  } catch (err) {
    let message = err instanceof GrpcWebParseError ? err.message : String(err);
    // The desktop proxy does not decompress bodies — a compressed payload is
    // the usual reason a well-formed response fails to parse here.
    const encoding = lensHeader(response, "content-encoding")?.toLowerCase();
    if (encoding && encoding !== "identity") {
      message += ` (body is ${encoding}-compressed and was not decompressed; resend with accept-encoding: identity)`;
    }
    return { protocol, malformed: message, frames: [], messages: [], trailer: null, endStream: null, bytes };
  }
}

// Render a schema-less WireView as plain JS for JSON.stringify. Field-number
// keys; single occurrence collapses to a scalar, repeated stays an array.
function wireViewToPlain(view: WireView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, fields] of Object.entries(view)) {
    const values = fields.map(wireFieldToPlain);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

function wireFieldToPlain(field: WireField): unknown {
  if (field.varint) {
    const n = Number(field.varint.unsigned);
    return Number.isSafeInteger(n) ? n : field.varint.unsigned;
  }
  if (field.fixed64) return { "@fixed64": { uint: field.fixed64.uint, double: field.fixed64.double } };
  if (field.fixed32) return { "@fixed32": { int: field.fixed32.int, float: field.fixed32.float } };
  if (field.lengthDelimited) {
    if (field.lengthDelimited.nested) return wireViewToPlain(field.lengthDelimited.nested);
    if (field.lengthDelimited.utf8 !== null) return field.lengthDelimited.utf8;
    return { "@bytes": field.lengthDelimited.base64 };
  }
  return null;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16);
    const hex = bytesToHex(slice).replace(/(..)/g, "$1 ").trim();
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(48)}  ${ascii}`);
  }
  return lines.join("\n") || "(empty)";
}

// Same compact set + toast duration as the gRPC client's ResponsePanel — this
// lens shows the same three headers by default, expandable to the rest.
const COMPACT_GRPC_HEADERS = new Set(["x-penguin-http-status", "x-penguin-http-version", "x-penguin-id"]);
const COPIED_FEEDBACK_MS = 1500;

type LensTab = "decoded" | "raw" | "headers";

export function GrpcWebResponseView({ response }: { response: RestResponse }): ReactElement {
  const decoded = useMemo(() => decode(response), [response]);
  const [tab, setTab] = useState<LensTab>("decoded");
  // Compact-by-default + click-to-copy headers — ports the gRPC client
  // ResponsePanel's exact header-row UX (same compact set, same floating
  // "Copied" toast at the click position), which this lens lacked.
  const [showAllHeaders, setShowAllHeaders] = useState(false);
  const [copyToast, setCopyToast] = useState<{ x: number; y: number; nonce: number } | null>(null);
  const handleCopyHeader = (payload: { value: string; x: number; y: number }): void => {
    void writeClipboard(payload.value);
    setCopyToast({ x: payload.x, y: payload.y, nonce: Date.now() });
  };
  useEffect(() => {
    if (copyToast === null) return;
    const timer = window.setTimeout(() => setCopyToast(null), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyToast]);
  const compactHeaders = response.headers.filter((h) => COMPACT_GRPC_HEADERS.has(h.key.toLowerCase()));
  const hiddenHeaderCount = response.headers.length - compactHeaders.length;
  const visibleHeaders = showAllHeaders ? response.headers : compactHeaders;

  const headerStatusText = response.headers
    .find((h) => h.key.toLowerCase() === "grpc-status")
    ?.value;
  const headerStatus = headerStatusText !== undefined ? Number(headerStatusText) : null;
  const trailerStatus = decoded.trailer?.status ?? null;
  // Body-trailer status is authoritative; the header is a fallback.
  const effectiveStatus = trailerStatus ?? (Number.isFinite(headerStatus) ? headerStatus : null);
  const statusDisagree =
    decoded.protocol === "grpc-web" &&
    trailerStatus !== null && headerStatus !== null && Number.isFinite(headerStatus) && trailerStatus !== headerStatus;
  // Non-grpc-web protocols have no grpc-status: bare proto reaches this lens
  // only on HTTP 200 (success by construction), and Connect streaming signals
  // errors in its end-stream JSON frame.
  const connectError = decoded.endStream?.error ?? null;
  const statusMessage = decoded.protocol === "grpc-web" ? (decoded.trailer?.message ?? null) : (connectError?.message ?? null);
  const protocolLabel =
    decoded.protocol === "grpc-web" ? "gRPC-Web" : decoded.protocol === "proto-unary" ? "Proto" : "Connect";
  // trailer-* response headers carry Connect unary trailing metadata — group
  // them separately in the headers tab so they read as trailers, not headers.
  const trailingMeta = visibleHeaders.filter((h) => h.key.toLowerCase().startsWith("trailer-"));
  const plainHeaders = visibleHeaders.filter((h) => !h.key.toLowerCase().startsWith("trailer-"));

  return (
    <div className="flex h-full flex-col">
      {/* Status line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs">
        <span className="font-mono text-muted-foreground">HTTP {response.status}</span>
        <span className="text-muted-foreground">·</span>
        {decoded.protocol === "proto-unary" ? (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono font-semibold text-emerald-500">
            Proto OK
          </span>
        ) : decoded.protocol === "connect-stream" ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono font-semibold",
              connectError === null ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500",
            )}
          >
            {connectError === null ? "Connect OK" : `Connect ${connectError.code}`}
          </span>
        ) : effectiveStatus !== null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono font-semibold",
              effectiveStatus === 0 ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500",
            )}
          >
            gRPC {effectiveStatus} {statusName(effectiveStatus)}
          </span>
        ) : (
          <span className="text-muted-foreground">gRPC status: —</span>
        )}
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {decoded.messages.length} message{decoded.messages.length === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{response.bodyBytes} B</span>
        {statusMessage && (
          <span className="w-full truncate text-muted-foreground" title={statusMessage}>
            {decoded.protocol === "grpc-web" ? "grpc-message" : "error"}:{" "}
            <span className="text-foreground">{statusMessage}</span>
          </span>
        )}
        {statusDisagree && (
          <span className="w-full text-red-500">
            ⚠ protocol error: trailer grpc-status {trailerStatus} ≠ header grpc-status {headerStatus}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-border px-3 py-1.5">
        {(["decoded", "raw", "headers"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {t === "raw" ? "Raw (hex)" : t}
          </button>
        ))}
        <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {protocolLabel} · schema-less
        </span>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {decoded.malformed && tab !== "raw" ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            Malformed {protocolLabel} response: {decoded.malformed}. See the Raw (hex) tab.
          </div>
        ) : tab === "decoded" ? (
          <DecodedTab decoded={decoded} />
        ) : tab === "raw" ? (
          <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-foreground">
            {hexDump(decoded.bytes)}
          </pre>
        ) : (
          <div>
            {hiddenHeaderCount > 0 && (
              <div className="mb-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowAllHeaders((expanded) => !expanded)}
                  className="text-[10px] text-primary hover:underline"
                >
                  {showAllHeaders ? "Hide extra headers" : `Show all headers (${response.headers.length})`}
                </button>
              </div>
            )}
            <div className="flex flex-col gap-1 font-mono text-[11px]">
              {plainHeaders.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => handleCopyHeader({ value: h.value, x: e.clientX, y: e.clientY })}
                  title="Click to copy / 点击复制"
                  className="flex gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
                >
                  <span className="shrink-0 text-muted-foreground">{h.key}:</span>
                  <span className="break-all text-foreground">{h.value}</span>
                </button>
              ))}
            </div>
            {trailingMeta.length > 0 && (
              <>
                <div className="mb-1 mt-3 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Trailing metadata (trailer-*)
                </div>
                <div className="flex flex-col gap-1 font-mono text-[11px]">
                  {trailingMeta.map((h, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={(e) => handleCopyHeader({ value: h.value, x: e.clientX, y: e.clientY })}
                      title="Click to copy / 点击复制"
                      className="flex gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
                    >
                      <span className="shrink-0 text-muted-foreground">{h.key}:</span>
                      <span className="break-all text-foreground">{h.value}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Copied toast — pops at the click position; mirrors the gRPC client's ResponsePanel. */}
      {copyToast !== null ? (
        <div
          key={copyToast.nonce}
          className="pointer-events-none fixed z-50 select-none rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white shadow-lg"
          style={{ left: copyToast.x + 12, top: copyToast.y - 28 }}
        >
          ✓ Copied
        </div>
      ) : null}
    </div>
  );
}

function DecodedTab({ decoded }: { decoded: DecodedGrpcWeb }): ReactElement {
  if (decoded.messages.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No message frames{decoded.trailer ? " — trailers-only response." : "."}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {decoded.messages.map((view, i) => (
        <div key={i}>
          {decoded.messages.length > 1 && (
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">message {i + 1}</div>
          )}
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
            {JSON.stringify(wireViewToPlain(view), null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
