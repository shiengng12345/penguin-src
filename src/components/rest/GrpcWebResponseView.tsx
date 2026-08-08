// gRPC-Web response lens for the REST module. When a response is gRPC-Web
// framed, this renders it far better than a raw byte dump: HTTP + gRPC status,
// each protobuf message as an honest schema-less field-number view, the
// trailers, and a raw hex fallback. Named-field decoding (via installed
// descriptors) is a separate, later path — this view never invents field names.

import { useMemo, useState, type ReactElement } from "react";
import {
  parseGrpcWebFrames,
  parseGrpcTrailers,
  decodeUnknownMessage,
  bytesToHex,
  GrpcWebParseError,
  type GrpcWebFrame,
  type GrpcTrailer,
  type WireField,
  type WireView,
} from "@penguin/core";
import { cn } from "@/lib/utils";
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

/** Content-type (request or response), normalized before `;`, is gRPC-Web. */
export function isGrpcWebResponse(response: RestResponse): boolean {
  const ct = response.headers
    .find((h) => h.key.toLowerCase() === "content-type")
    ?.value.split(";")[0]
    .trim()
    .toLowerCase();
  return ct === "application/grpc-web" || ct === "application/grpc-web+proto";
}

interface DecodedGrpcWeb {
  malformed: string | null;
  frames: GrpcWebFrame[];
  messages: WireView[];
  trailer: GrpcTrailer | null;
  bytes: Uint8Array;
}

function decode(response: RestResponse): DecodedGrpcWeb {
  const bytes =
    response.bodyEncoding === "base64"
      ? base64ToBytes(response.body)
      : new TextEncoder().encode(response.body);
  try {
    const frames = parseGrpcWebFrames(bytes);
    const messages = frames
      .filter((f) => !f.trailer)
      .map((f) => decodeUnknownMessage(f.data));
    return { malformed: null, frames, messages, trailer: parseGrpcTrailers(frames), bytes };
  } catch (err) {
    const message = err instanceof GrpcWebParseError ? err.message : String(err);
    return { malformed: message, frames: [], messages: [], trailer: null, bytes };
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

type LensTab = "decoded" | "raw" | "headers";

export function GrpcWebResponseView({ response }: { response: RestResponse }): ReactElement {
  const decoded = useMemo(() => decode(response), [response]);
  const [tab, setTab] = useState<LensTab>("decoded");

  const headerStatusText = response.headers
    .find((h) => h.key.toLowerCase() === "grpc-status")
    ?.value;
  const headerStatus = headerStatusText !== undefined ? Number(headerStatusText) : null;
  const trailerStatus = decoded.trailer?.status ?? null;
  // Body-trailer status is authoritative; the header is a fallback.
  const effectiveStatus = trailerStatus ?? (Number.isFinite(headerStatus) ? headerStatus : null);
  const statusDisagree =
    trailerStatus !== null && headerStatus !== null && Number.isFinite(headerStatus) && trailerStatus !== headerStatus;
  const grpcMessage = decoded.trailer?.message ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Status line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs">
        <span className="font-mono text-muted-foreground">HTTP {response.status}</span>
        <span className="text-muted-foreground">·</span>
        {effectiveStatus !== null ? (
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
        {grpcMessage && (
          <span className="w-full truncate text-muted-foreground" title={grpcMessage}>
            grpc-message: <span className="text-foreground">{grpcMessage}</span>
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
          gRPC-Web · schema-less
        </span>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {decoded.malformed && tab !== "raw" ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            Malformed gRPC-Web response: {decoded.malformed}. See the Raw (hex) tab.
          </div>
        ) : tab === "decoded" ? (
          <DecodedTab decoded={decoded} />
        ) : tab === "raw" ? (
          <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-foreground">
            {hexDump(decoded.bytes)}
          </pre>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {response.headers.map((h, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{h.key}:</span>
                <span className="break-all text-foreground">{h.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
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
