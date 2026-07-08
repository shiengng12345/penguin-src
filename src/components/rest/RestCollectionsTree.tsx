// Sprint 10 Phase 10A.7 — Postman-style collections tree.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Check, Folder, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RestCollection, RestRequestRecord } from "./rest-types";
import { Input } from "@/components/ui/input";

export interface RestCollectionsTreeProps {
  collections: RestCollection[];
  requests: RestRequestRecord[];
  search: string;
  activeRequestId: string | null;
  onSelectRequest: (id: string) => void;
  onNewRequest: (collectionId: string) => void;
  onDeleteRequest: (id: string) => void;
  onDeleteCollection: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-600 dark:text-emerald-400",
  POST: "text-orange-500 dark:text-orange-400",
  PUT: "text-amber-600 dark:text-amber-400",
  PATCH: "text-violet-600 dark:text-violet-400",
  DELETE: "text-red-500 dark:text-red-400",
  HEAD: "text-sky-500 dark:text-sky-400",
  OPTIONS: "text-fuchsia-500 dark:text-fuchsia-400",
};

export function RestCollectionsTree(props: RestCollectionsTreeProps) {
  // Track expansion state per collection — default: all expanded (Postman).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Inline two-click delete confirm — first click arms (key = "req:<id>" /
  // "col:<id>"), second click deletes. Avoids window.confirm(), which can
  // silently return false in Tauri's webview. Auto-disarms after 3s.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmKey) return;
    const t = window.setTimeout(() => setConfirmKey(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmKey]);
  // Returns true if this click should perform the delete (already armed).
  const armOrConfirm = (key: string): boolean => {
    if (confirmKey === key) {
      setConfirmKey(null);
      return true;
    }
    setConfirmKey(key);
    return false;
  };

  const commitRename = () => {
    if (renamingId && renameDraft.trim()) {
      props.onRenameCollection(renamingId, renameDraft.trim());
    }
    setRenamingId(null);
    setRenameDraft("");
  };

  const filtered = useMemo(() => {
    const q = props.search.trim().toLowerCase();
    if (!q) {
      return props.collections.map((c) => ({
        collection: c,
        requests: props.requests.filter((r) => r.collectionId === c.id),
      }));
    }
    return props.collections
      .map((c) => {
        const reqs = props.requests.filter(
          (r) =>
            r.collectionId === c.id &&
            (r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)),
        );
        const collectionMatches = c.name.toLowerCase().includes(q);
        return {
          collection: c,
          requests: collectionMatches
            ? props.requests.filter((r) => r.collectionId === c.id)
            : reqs,
          visible: collectionMatches || reqs.length > 0,
        };
      })
      .filter((node) => node.visible !== false);
  }, [props.collections, props.requests, props.search]);

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
        {props.search ? "No matches" : "No collections — click + above to add"}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {filtered.map(({ collection, requests }) => {
        const isCollapsed = collapsed.has(collection.id);
        const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
        const Icon = isCollapsed ? Folder : FolderOpen;
        return (
          <div key={collection.id} className="mb-0.5">
            <div
              role="button"
              tabIndex={0}
              className="group flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-accent/50"
              onClick={() => {
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(collection.id)) next.delete(collection.id);
                  else next.add(collection.id);
                  return next;
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(collection.id)) next.delete(collection.id);
                    else next.add(collection.id);
                    return next;
                  });
                }
              }}
            >
              <ChevronIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
              <Icon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              {renamingId === collection.id ? (
                <Input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); setRenameDraft(""); }
                  }}
                  onBlur={commitRename}
                  className="h-5 flex-1 text-xs"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate text-foreground">{collection.name}</span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(collection.id);
                    setRenameDraft(collection.name);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  title="New request"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onNewRequest(collection.id);
                  }}
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className={cn(
                    "hover:text-destructive",
                    confirmKey === `col:${collection.id}` ? "text-destructive" : "text-muted-foreground",
                  )}
                  title={confirmKey === `col:${collection.id}` ? "Click again to confirm delete" : "Delete collection"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armOrConfirm(`col:${collection.id}`)) props.onDeleteCollection(collection.id);
                  }}
                >
                  {confirmKey === `col:${collection.id}` ? <Check className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </span>
            </div>
            {!isCollapsed && (
              <div className="ml-3 border-l border-border/60 pl-2">
                {requests.length === 0 ? (
                  <p className="px-2 py-1 text-[10px] text-muted-foreground/60">No requests</p>
                ) : (
                  requests.map((r) => {
                    const isActive = r.id === props.activeRequestId;
                    return (
                      <div
                        key={r.id}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left",
                          isActive ? "bg-primary/10" : "hover:bg-accent/50",
                        )}
                        onClick={() => props.onSelectRequest(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelectRequest(r.id); }
                        }}
                      >
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[9px] font-bold",
                            METHOD_COLORS[r.method] ?? "text-muted-foreground",
                          )}
                        >
                          {r.method}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[11px]",
                            isActive ? "text-primary" : "text-foreground",
                          )}
                        >
                          {r.name}
                        </span>
                        {/* Real <button> sibling — NOT nested in an interactive
                            row (WebKit retargets clicks on children to the
                            enclosing <button>, which swallowed this delete). */}
                        <button
                          type="button"
                          className={cn(
                            "shrink-0 transition-opacity hover:text-destructive",
                            confirmKey === `req:${r.id}`
                              ? "text-destructive opacity-100"
                              : "text-muted-foreground opacity-0 group-hover:opacity-100",
                          )}
                          title={confirmKey === `req:${r.id}` ? "Click again to confirm delete" : "Delete request"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (armOrConfirm(`req:${r.id}`)) props.onDeleteRequest(r.id);
                          }}
                        >
                          {confirmKey === `req:${r.id}` ? <Check className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
