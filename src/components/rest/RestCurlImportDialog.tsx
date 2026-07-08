// Sprint 10 Phase 10C — Import a request from a cURL command into REST.
//
// User pastes a curl command, dialog parses it via the shared parseCurl
// helper, previews method / URL / header count / body presence, lets them
// pick a destination collection (with inline-create like the New Request
// dialog), and imports it as a fresh RestRequestRecord opened in a tab.
//
// Replaces the previous behavior where ⌘+Shift+I inside the REST module
// would silently open the gRPC-shaped CurlImport which created a gRPC tab.

import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { parseCurl, type ParsedCurl } from "@/lib/curl-parser";
import { jsonToFields } from "@/lib/rest-body-fields";
import type {
  RestAuth,
  RestBody,
  RestCollection,
  RestHeader,
  RestMethod,
  RestRequestRecord,
} from "./rest-types";
import { saveSecret } from "./rest-keychain";

// Well-known API-key header names. Lowercase compare so case variants
// (X-Api-Key vs X-API-Key vs x-api-key) all promote to req.auth and get
// stripped from the plaintext header list.
const API_KEY_HEADER_NAMES = new Set([
  "x-api-key",
  "x-api-token",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
]);

const CREATE_SENTINEL = "__create__";
const VALID_METHODS: ReadonlySet<RestMethod> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export interface RestCurlImportDialogProps {
  open: boolean;
  onClose: () => void;
  collections: RestCollection[];
  defaultCollectionId: string | null;
  hasProject: boolean;
  // Returns the imported request so RestPage can open it in a tab.
  onImport: (params: {
    collectionId: string;
    name: string;
    method: RestMethod;
    url: string;
    headers: RestHeader[];
    body?: RestBody;
    // Auth that was promoted out of the headers into the keychain. Empty
    // (no field) when the curl had no recognisable auth header.
    auth?: RestAuth;
  }) => RestRequestRecord;
  onCreateCollection: (name: string) => string;
}

export function RestCurlImportDialog(props: RestCurlImportDialogProps) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live parse — also drives the disabled state of Import.
  const parsed = useMemo<ParsedCurl | null>(() => {
    if (!text.trim()) return null;
    return parseCurl(text);
  }, [text]);

  // Reset / preselect on every open.
  useEffect(() => {
    if (!props.open) return;
    setText("");
    setName("");
    setNewCollectionName("");
    setError(null);
    if (props.collections.length === 0) {
      setCollectionId(null);
      setCreatingCollection(props.hasProject);
    } else {
      setCollectionId(props.defaultCollectionId ?? props.collections[0].id);
      setCreatingCollection(false);
    }
  }, [props.open, props.defaultCollectionId, props.collections, props.hasProject]);

  // Auto-name from the parsed URL if user hasn't typed one — only fills the
  // FIRST time so subsequent edits to text don't clobber a hand-typed name.
  useEffect(() => {
    if (!parsed) return;
    setName((current) => current.trim() || deriveNameFromUrl(parsed.url));
  }, [parsed]);

  // Local Esc — same pattern as New Request dialog (capture-phase, doesn't
  // bubble up to RestPage's outer Esc which would close the whole module).
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const commitCollection = () => {
    const collName = newCollectionName.trim();
    if (!collName) return;
    const id = props.onCreateCollection(collName);
    setCollectionId(id);
    setCreatingCollection(false);
    setNewCollectionName("");
  };

  // Critical secret-handling step (DEC #195). The pasted curl likely
  // contains an Authorization or API-key header in plaintext. We MUST move
  // those values into the OS keychain via saveSecret() before they land in
  // app_kv / history snapshots / IPC. Returns the cleaned header list +
  // a RestAuth pointing at the keychain handles.
  const promoteAuthHeaders = async (
    rawHeaders: RestHeader[],
  ): Promise<{ headers: RestHeader[]; auth?: RestAuth }> => {
    const kept: RestHeader[] = [];
    let auth: RestAuth | undefined;
    for (const h of rawHeaders) {
      const lc = h.key.toLowerCase();
      // 1. Authorization: Bearer <token>
      if (lc === "authorization" && /^bearer\s+/i.test(h.value) && !auth) {
        try {
          const handle = await saveSecret({
            collectionId: collectionId!,
            key: `rest:imported:${Date.now()}:auth:bearer`,
            plaintext: h.value.trim(),
          });
          auth = { kind: "bearer", tokenHandleId: handle.id };
          continue; // strip
        } catch {
          // keychain unreachable — keep the header rather than lose info
          kept.push(h);
        }
        continue;
      }
      // 2. Authorization: Basic <base64(user:pass)>
      if (lc === "authorization" && /^basic\s+/i.test(h.value) && !auth) {
        const b64 = h.value.replace(/^basic\s+/i, "").trim();
        let username = "(from curl)";
        try {
          const decoded = atob(b64);
          const idx = decoded.indexOf(":");
          if (idx > 0) username = decoded.slice(0, idx);
        } catch {
          // base64 garbage — leave username as placeholder, still save value
        }
        try {
          const handle = await saveSecret({
            collectionId: collectionId!,
            key: `rest:imported:${Date.now()}:auth:basic`,
            plaintext: h.value.trim(), // full "Basic xxx" header value
          });
          auth = { kind: "basic", username, passwordHandleId: handle.id };
          continue;
        } catch {
          kept.push(h);
        }
        continue;
      }
      // 3. Well-known API key headers.
      if (API_KEY_HEADER_NAMES.has(lc) && !auth) {
        try {
          const handle = await saveSecret({
            collectionId: collectionId!,
            key: `rest:imported:${Date.now()}:auth:api-key`,
            plaintext: h.value,
          });
          auth = {
            kind: "api-key",
            in: "header",
            name: h.key,
            valueHandleId: handle.id,
          };
          continue;
        } catch {
          kept.push(h);
        }
        continue;
      }
      kept.push(h);
    }
    return { headers: kept, auth };
  };

  const commitImport = async () => {
    setError(null);
    if (!parsed) {
      setError("Couldn't parse the curl command — does it start with `curl`?");
      return;
    }
    if (!collectionId) {
      setError("Pick or create a collection first.");
      return;
    }
    const method = (parsed.method.toUpperCase() as RestMethod);
    if (!VALID_METHODS.has(method)) {
      setError(`Unsupported HTTP method: ${parsed.method}`);
      return;
    }
    const rawHeaders: RestHeader[] = Object.entries(parsed.headers).map(([key, value]) => ({
      key,
      value,
      enabled: true,
    }));
    const { headers, auth } = await promoteAuthHeaders(rawHeaders);
    const body = inferBody(parsed);
    props.onImport({
      collectionId,
      name: name.trim() || deriveNameFromUrl(parsed.url),
      method,
      url: parsed.url,
      headers,
      body,
      auth,
    });
    props.onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={props.onClose}
      />
      <div
        role="dialog"
        aria-labelledby="rest-curl-import-title"
        className="relative z-50 w-full max-w-xl rounded-lg border border-border bg-popover shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="rest-curl-import-title" className="flex items-center gap-2 text-sm font-semibold">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            Import from cURL
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!props.hasProject ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            Create a project in the sidebar first.
          </div>
        ) : (
          <div className="space-y-3 p-4">
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Paste curl command
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="curl -X POST https://api.example.com/v1/users -H 'Content-Type: application/json' --data '{&quot;name&quot;:&quot;Ada&quot;}'"
                rows={6}
                spellCheck={false}
                className="w-full rounded border border-input bg-background p-2 font-mono text-[11px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>

            {parsed && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Parsed
                </label>
                <div className="space-y-1 rounded border border-border bg-muted/30 px-2 py-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold", methodColor(parsed.method))}>
                      {parsed.method.toUpperCase()}
                    </span>
                    <span className="truncate font-mono">{parsed.url}</span>
                  </div>
                  <div className="flex gap-3 text-muted-foreground">
                    <span>{Object.keys(parsed.headers).length} header{Object.keys(parsed.headers).length === 1 ? "" : "s"}</span>
                    {parsed.body && (
                      <span>
                        <FileText className="mr-0.5 inline-block h-3 w-3 -translate-y-0.5" />
                        {parsed.body.length} byte{parsed.body.length === 1 ? "" : "s"} body
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Name (optional)
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={parsed ? deriveNameFromUrl(parsed.url) : "Imported request"}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Save to
              </label>
              {creatingCollection ? (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={newCollectionName}
                    onChange={(e) => setNewCollectionName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitCollection();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        if (props.collections.length > 0) {
                          setCreatingCollection(false);
                          setCollectionId(props.collections[0].id);
                        } else {
                          props.onClose();
                        }
                      }
                    }}
                    placeholder="New collection name"
                    className="h-8 flex-1 text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={commitCollection}
                    disabled={!newCollectionName.trim()}
                    className="h-8 text-xs"
                  >
                    Create
                  </Button>
                </div>
              ) : (
                <select
                  value={collectionId ?? ""}
                  onChange={(e) => {
                    if (e.target.value === CREATE_SENTINEL) {
                      setCreatingCollection(true);
                      return;
                    }
                    setCollectionId(e.target.value || null);
                  }}
                  className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
                >
                  {props.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={CREATE_SENTINEL}>+ New collection...</option>
                </select>
              )}
            </div>

            {error && (
              <p className="text-[11px] text-red-500">{error}</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void commitImport()}
            disabled={!parsed || !props.hasProject || !collectionId}
          >
            <Download className="mr-1 h-3 w-3" />
            Import
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- helpers ----

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").filter(Boolean).slice(-2).join("/") || u.host;
    return path || "Imported request";
  } catch {
    return "Imported request";
  }
}

function inferBody(parsed: ParsedCurl): RestBody | undefined {
  if (!parsed.body) return undefined;
  const contentType = (
    findHeader(parsed.headers, "Content-Type") ?? ""
  ).toLowerCase();
  // JSON-object body → editable key-value form (kept in sync with the JSON tab).
  const kvFields = jsonToFields(parsed.body);
  if (kvFields.length > 0) {
    return { mode: "key-value", fields: kvFields };
  }
  if (contentType.includes("application/json")) {
    return { mode: "json", content: parsed.body };
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const fields: RestHeader[] = [];
    for (const pair of parsed.body.split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      fields.push({
        key: decodeURIComponent(pair.slice(0, eq)),
        value: decodeURIComponent(pair.slice(eq + 1)),
        enabled: true,
      });
    }
    return { mode: "form-urlencoded", fields };
  }
  return { mode: "raw", content: parsed.body };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lc) return v;
  }
  return undefined;
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "POST":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "PUT":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "PATCH":
      return "bg-violet-500/15 text-violet-600 dark:text-violet-400";
    case "DELETE":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}
