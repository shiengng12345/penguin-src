// Simplified layout (no multi-tab workspace, matches client module):
//   ┌────────────────────────────────────────────────────────┐
//   │ Workspace header: REST  …  + New                       │
//   ├──────────────┬─────────────────────────────────────────┤
//   │ 🔍 Search    │ Name [Save]                             │
//   │ ▾ Projects + │ GET▾ URL ────────── [Send]              │
//   │   Newport    │ Params │ Auth │ Headers │ Body           │
//   │ ▾ Envs    +  │                                          │
//   │   DEV        │ ─── Response ───                         │
//   │ Collections+ │                                          │
//   │  ▾ auth      │                                          │
//   │    GET /…    │                                          │
//   └──────────────┴─────────────────────────────────────────┘

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import {
  REST_CLOSE_TAB_EVENT,
  REST_FOCUS_SEARCH_EVENT,
  REST_NEW_REQUEST_EVENT,
  REST_OPEN_CURL_IMPORT_EVENT,
  REST_OPEN_HISTORY_EVENT,
} from "@/lib/rest-events";
import {
  createCollection,
  createEnvironment,
  createProject,
  createRequest,
  deleteCollection,
  deleteEnvVar,
  deleteEnvironment,
  deleteProject,
  deleteRequest,
  loadCollections,
  loadEnvVars,
  loadEnvironments,
  loadProjects,
  loadRequests,
  renameCollection,
  renameEnvironment,
  renameProject,
  upsertEnvVar,
  upsertRequest,
} from "./rest-storage";
import type {
  RestCollection,
  RestEnvironment,
  RestEnvVar,
  RestProject,
  RestRequestRecord,
} from "./rest-types";
import { RestSidebar } from "./RestSidebar";
import { RestRequestEditor } from "./RestRequestEditor";
import { RestNewRequestDialog } from "./RestNewRequestDialog";
import { RestCurlImportDialog } from "./RestCurlImportDialog";
import { RestHistoryPanel } from "./RestHistoryPanel";
import type { RestHistoryEntry } from "./rest-history";
import { handleIdForAuth, resolveSecretMasked, stripAuthHandle } from "./rest-keychain";
import type { RestAuth } from "./rest-types";
import type { RestBody, RestHeader, RestMethod } from "./rest-types";

export interface RestPageProps {
  onClose: () => void;
}

export function RestPage({ onClose }: RestPageProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // WHY: inline editors (sidebar rename/create, find-in-response) cancel
      // with Escape + preventDefault — honoring defaultPrevented keeps their
      // Escape from bubbling up and closing the whole REST module.
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // CodeMirror chunk prefetch lives at module-level in
  // RestRequestEditor.tsx (kicks when that module first evaluates,
  // i.e. when RestPage imports it during initial load). The earlier
  // useEffect prefetch turned out to fire too late for fast users —
  // module-level fires before React even commits.

  // Sidebar search input — referenced by REST_FOCUS_SEARCH_EVENT (Cmd+F).
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [projects, setProjects] = useState<RestProject[]>(() => loadProjects());
  const [environments, setEnvironments] = useState<RestEnvironment[]>(() => loadEnvironments());
  const [collections, setCollections] = useState<RestCollection[]>(() => loadCollections());
  const [requests, setRequests] = useState<RestRequestRecord[]>(() => loadRequests());
  const [envVars, setEnvVars] = useState<RestEnvVar[]>(() => loadEnvVars());

  // Workspace UI state lives in Zustand (session-only). Lifted out so
  // module switch (REST → Vault → REST) doesn't reset sidebar selections.
  const workspace = useAppStore((s) => s.restWorkspace);
  const setWorkspace = useAppStore((s) => s.setRestWorkspace);
  const selectedProjectId = workspace.selectedProjectId;
  const selectedEnvId = workspace.selectedEnvId;
  const setSelectedProjectId = (id: string | null) => setWorkspace({ selectedProjectId: id });
  const setSelectedEnvId = (id: string | null) => setWorkspace({ selectedEnvId: id });

  // Single active request (no multi-tab workspace — matches client module layout).
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  // Bootstrap: on first mount of the session, seed selectedProjectId
  // to the first project if nothing's been picked yet. Subsequent
  // mounts (module switch back) skip this — the store already has the
  // user's last choice.
  useEffect(() => {
    if (selectedProjectId === null && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [search, setSearch] = useState("");

  // "New Request" dialog state — driven by ⌘N / ⌘T / header + button.
  const [newRequestDialogOpen, setNewRequestDialogOpen] = useState(false);
  // cURL import dialog — driven by ⌘+Shift+I when REST module is active.
  const [curlImportOpen, setCurlImportOpen] = useState(false);
  // History panel — driven by ⌘+H when REST module is active.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Transient warning banner — surfaces when a history replay's stored auth
  // can't be re-resolved (credential was rotated / cleared from keychain).
  const [replayWarning, setReplayWarning] = useState<string | null>(null);
  // Tracks the collection the user last opened a request under (or sidebar
  // selection). Used as the dialog's default picker target.
  const lastCollectionId = useAppStore((s) => s.restWorkspace.lastCollectionId);
  const setLastCollectionId = (id: string | null) =>
    useAppStore.getState().setRestWorkspace({ lastCollectionId: id });

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const projectCollections = useMemo(
    () =>
      selectedProject
        ? collections.filter(
            (c) =>
              c.projectId === selectedProject.id &&
              (selectedEnvId === null ? c.envId === null : c.envId === selectedEnvId),
          )
        : [],
    [collections, selectedProject, selectedEnvId],
  );
  const activeRequest = useMemo(
    () => requests.find((r) => r.id === activeRequestId) ?? null,
    [requests, activeRequestId],
  );

  // ---- Project handlers (name string from inline sidebar input) ----
  const handleNewProject = (name: string) => {
    const p = createProject({ name });
    setProjects(loadProjects());
    setSelectedProjectId(p.id);
    setSelectedEnvId(null);
  };

  const handleRenameProject = (id: string, name: string) => {
    setProjects(renameProject({ id, name }));
  };

  const handleDeleteProject = (id: string) => {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    // window.confirm works fine in Tauri; only prompt() is dodgy. Keep confirm
    // for now — replace with VaultConfirmModal in a follow-up if needed.
    if (!window.confirm(`Delete project "${p.name}" and all its envs / collections / requests?`)) {
      return;
    }
    setProjects(deleteProject({ id }));
    setEnvironments(loadEnvironments());
    setCollections(loadCollections());
    setRequests(loadRequests());
    if (selectedProjectId === id) {
      setSelectedProjectId(null);
      setSelectedEnvId(null);
    }
    setActiveRequestId(null);
  };

  // ---- Env handlers ----
  const handleNewEnvironment = (name: string) => {
    if (!selectedProject) return;
    const env = createEnvironment({ projectId: selectedProject.id, name });
    setEnvironments(loadEnvironments());
    setSelectedEnvId(env.id);
  };

  const handleRenameEnvironment = (id: string, name: string) => {
    setEnvironments(renameEnvironment({ id, name }));
  };

  const handleDeleteEnvironment = (id: string) => {
    const env = environments.find((e) => e.id === id);
    if (!env) return;
    if (!window.confirm(`Delete environment "${env.name}"? Its collections will become unscoped.`)) {
      return;
    }
    setEnvironments(deleteEnvironment({ id }));
    setCollections(loadCollections());
    if (selectedEnvId === id) setSelectedEnvId(null);
  };

  // ---- Collection handlers ----
  const handleNewCollection = (name: string) => {
    if (!selectedProject) return;
    createCollection({
      projectId: selectedProject.id,
      envId: selectedEnvId,
      name,
    });
    setCollections(loadCollections());
  };

  const handleDeleteCollection = (id: string) => {
    const col = collections.find((c) => c.id === id);
    if (!col) return;
    // Confirmation is inline (two-click) in RestCollectionsTree — window.confirm
    // can silently return false in Tauri's webview, which ate the delete.
    setCollections(deleteCollection({ id }));
    setRequests(loadRequests());
    // Clear active request if it belonged to the deleted collection
    if (activeRequest?.collectionId === id) setActiveRequestId(null);
  };

  const handleRenameCollection = (id: string, name: string) => {
    setCollections(renameCollection({ id, name }));
  };

  // ---- Env var handlers ----
  const envVarsForSelectedEnv = useMemo(
    () => envVars.filter((v) => v.scope === "env" && v.scopeId === selectedEnvId),
    [envVars, selectedEnvId],
  );

  const envVarMap = useMemo(
    () => {
      const m: Record<string, string> = {};
      for (const v of envVarsForSelectedEnv) {
        if (v.key.trim() && v.value != null) m[v.key.trim()] = v.value;
      }
      return m;
    },
    [envVarsForSelectedEnv],
  );

  const handleUpsertEnvVar = (v: RestEnvVar) => {
    setEnvVars(upsertEnvVar(v));
  };

  const handleDeleteEnvVar = (id: string) => {
    setEnvVars(deleteEnvVar(id));
  };

  // ---- Request handlers ----
  const handleNewRequest = (collectionId: string) => {
    const r = createRequest({ collectionId, name: "New Request" });
    setRequests(loadRequests());
    setLastCollectionId(collectionId);
    setActiveRequestId(r.id);
  };

  // Called when the user picks a method in the New Request dialog. Creates
  // the record with the chosen method (default name + empty URL), opens it
  // in a tab, then closes the dialog.
  const handleCreateFromDialog = ({
    method,
    collectionId,
  }: {
    method: RestMethod;
    collectionId: string;
  }) => {
    const r = createRequest({ collectionId, name: "Untitled" });
    const promoted: RestRequestRecord = { ...r, method };
    upsertRequest(promoted);
    setRequests(loadRequests());
    setLastCollectionId(collectionId);
    setActiveRequestId(r.id);
    setNewRequestDialogOpen(false);
  };

  // Dialog asks for a fresh collection inline. Returns the new id so the
  // dialog can auto-select it before the user clicks a method.
  const handleCreateCollectionFromDialog = (name: string): string => {
    if (!selectedProject) return "";
    const c = createCollection({
      projectId: selectedProject.id,
      envId: selectedEnvId,
      name,
    });
    setCollections(loadCollections());
    return c.id;
  };

  // Inline project-create from the dialog (when user lands on REST with no
  // projects). The dialog stays open; flipping selectedProjectId triggers its
  // re-render → since the brand-new project has zero collections, the dialog
  // auto-cascades into collection-create.
  const handleCreateProjectFromDialog = (name: string) => {
    const p = createProject({ name });
    setProjects(loadProjects());
    setSelectedProjectId(p.id);
    setSelectedEnvId(null);
  };

  // History replay — recreate a request from a stored snapshot. Uses the
  // currently-selected collection if the snapshot's original collection is
  // gone (deleted since), or the first collection in the active scope.
  //
  // Auth handles in the snapshot reference OS-keychain entries. We verify
  // each one is still resolvable BEFORE wiring it onto the new request —
  // a rotated/deleted credential would otherwise surface as a raw
  // "secret-not-found" error from the Rust send path. Better to strip the
  // auth + warn the user to re-enter it under the Authorization tab.
  const handleReplayFromHistory = async (entry: RestHistoryEntry) => {
    let targetCollectionId = entry.collectionId;
    if (!targetCollectionId || !collections.some((c) => c.id === targetCollectionId)) {
      targetCollectionId = projectCollections[0]?.id ?? null;
    }
    if (!targetCollectionId) {
      // No collection to drop the replay into — open the new-request dialog
      // so the user can pick one.
      setNewRequestDialogOpen(true);
      return;
    }

    // Validate auth handle ids — strip if the keychain entry is gone.
    let resolvedAuth: RestAuth | undefined = entry.snapshot.auth;
    let authStripped = false;
    if (resolvedAuth) {
      const handleId = handleIdForAuth(resolvedAuth);
      if (handleId) {
        try {
          await resolveSecretMasked({ id: handleId });
        } catch {
          // Keychain entry missing — drop the auth field. The replayed
          // request lands with mode=none; user re-enters under Authorization.
          resolvedAuth = stripAuthHandle(resolvedAuth);
          authStripped = true;
        }
      }
    }

    const r = createRequest({ collectionId: targetCollectionId, name: `${entry.requestName} (replay)` });
    const promoted: RestRequestRecord = {
      ...r,
      method: entry.snapshot.method,
      url: entry.snapshot.url,
      headers: entry.snapshot.headers,
      queryParams: entry.snapshot.queryParams,
      body: entry.snapshot.body,
      auth: resolvedAuth,
      followRedirects: entry.snapshot.followRedirects,
      timeoutMs: entry.snapshot.timeoutMs,
    };
    upsertRequest(promoted);
    setRequests(loadRequests());
    setLastCollectionId(targetCollectionId);
    setActiveRequestId(promoted.id);

    if (authStripped) {
      setReplayWarning(
        "Stored credentials for this request are no longer in your keychain — please re-enter them under the Authorization section.",
      );
      window.setTimeout(() => setReplayWarning(null), 8000);
    }
  };

  // cURL import — create + open a brand-new request with the parsed values
  // already filled in. Reuses the same createRequest path so the record is
  // persisted exactly like a hand-built one. Auth headers detected by the
  // import dialog have already been promoted to the OS keychain — we just
  // attach the resulting RestAuth pointing at the handle (no plaintext).
  const handleImportFromCurl = (params: {
    collectionId: string;
    name: string;
    method: RestMethod;
    url: string;
    headers: RestHeader[];
    body?: RestBody;
    auth?: RestAuth;
  }) => {
    const r = createRequest({ collectionId: params.collectionId, name: params.name });
    const promoted: RestRequestRecord = {
      ...r,
      method: params.method,
      url: params.url,
      headers: params.headers,
      body: params.body,
      auth: params.auth,
    };
    upsertRequest(promoted);
    setRequests(loadRequests());
    setLastCollectionId(params.collectionId);
    setActiveRequestId(promoted.id);
    return promoted;
  };

  const handleDeleteRequest = (id: string) => {
    const r = requests.find((req) => req.id === id);
    if (!r) return;
    // Confirmation is inline (two-click) in RestCollectionsTree.
    setRequests(deleteRequest({ id }));
    if (activeRequestId === id) setActiveRequestId(null);
    // Drop the session-only response slot for this id so deleted
    // requests don't keep their response payload pinned in memory.
    useAppStore.getState().clearRestResponse(id);
  };

  const handleUpdateRequest = (next: RestRequestRecord) => {
    setRequests(upsertRequest(next));
  };

  // Header "+ New" and ⌘N / ⌘T both route here — open the New Request dialog
  // so the user picks method + collection before the tab opens. The previous
  // one-click default-GET shortcut was unhelpful (users wanted POST/PUT/etc.).
  const handleNewFromHeader = () => {
    setNewRequestDialogOpen(true);
  };

  // Listen for REST-scoped keyboard events dispatched by App.tsx.
  useEffect(() => {
    const onNewRequest = () => handleNewFromHeader();
    // Cmd+W (close-tab) in REST module: just deselect the active request
    const onCloseCurrent = () => {
      if (activeRequestId) setActiveRequestId(null);
    };
    const onFocusSearch = () => {
      const el = searchInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    };
    const onOpenCurlImport = () => setCurlImportOpen(true);
    const onOpenHistory = () => setHistoryOpen(true);
    document.addEventListener(REST_NEW_REQUEST_EVENT, onNewRequest);
    document.addEventListener(REST_CLOSE_TAB_EVENT, onCloseCurrent);
    document.addEventListener(REST_FOCUS_SEARCH_EVENT, onFocusSearch);
    document.addEventListener(REST_OPEN_CURL_IMPORT_EVENT, onOpenCurlImport);
    document.addEventListener(REST_OPEN_HISTORY_EVENT, onOpenHistory);
    return () => {
      document.removeEventListener(REST_NEW_REQUEST_EVENT, onNewRequest);
      document.removeEventListener(REST_CLOSE_TAB_EVENT, onCloseCurrent);
      document.removeEventListener(REST_FOCUS_SEARCH_EVENT, onFocusSearch);
      document.removeEventListener(REST_OPEN_CURL_IMPORT_EVENT, onOpenCurlImport);
      document.removeEventListener(REST_OPEN_HISTORY_EVENT, onOpenHistory);
    };
  });

  // Pre-fill the dialog's collection picker with the best guess: last opened,
  // active tab's collection, sidebar-selected env's first collection, etc.
  const dialogDefaultCollectionId =
    lastCollectionId && projectCollections.some((c) => c.id === lastCollectionId)
      ? lastCollectionId
      : activeRequest && projectCollections.some((c) => c.id === activeRequest.collectionId)
        ? activeRequest.collectionId
        : projectCollections[0]?.id ?? null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header — module title + global actions (no env dropdown, sidebar owns project + env now) */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card/30 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">REST</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={handleNewFromHeader}
          >
            <Plus className="mr-1 h-3 w-3" />
            New
          </Button>
        </div>
      </div>

      {/* Main: sidebar + workspace. min-w-0 on the row prevents the
          workspace column's content (response body, code editor) from
          inflating the row past viewport. Defense-in-depth — App.tsx
          already provides min-w-0 above, but tightening here makes the
          contract local. */}
      <div className="flex flex-1 min-h-0 min-w-0">
        <RestSidebar
          projects={projects}
          environments={environments}
          collections={collections}
          requests={requests}
          selectedProjectId={selectedProjectId}
          selectedEnvId={selectedEnvId}
          activeRequestId={activeRequestId}
          search={search}
          onSearchChange={setSearch}
          searchInputRef={searchInputRef}
          onSelectProject={(id) => {
            setSelectedProjectId(id);
            setSelectedEnvId(null);
          }}
          onNewProject={handleNewProject}
          onRenameProject={handleRenameProject}
          onDeleteProject={handleDeleteProject}
          onSelectEnv={setSelectedEnvId}
          onNewEnvironment={handleNewEnvironment}
          onRenameEnvironment={handleRenameEnvironment}
          onDeleteEnvironment={handleDeleteEnvironment}
          onNewCollection={handleNewCollection}
          onDeleteCollection={handleDeleteCollection}
          onRenameCollection={handleRenameCollection}
          onSelectRequest={setActiveRequestId}
          onNewRequest={handleNewRequest}
          onDeleteRequest={handleDeleteRequest}
          envVars={envVarsForSelectedEnv}
          onUpsertEnvVar={handleUpsertEnvVar}
          onDeleteEnvVar={handleDeleteEnvVar}
        />

        <div className="flex flex-1 min-h-0 min-w-0 flex-col">
          {replayWarning && (
            <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px]">
              <span className="font-semibold text-amber-600 dark:text-amber-400">⚠</span>
              <span className="flex-1 text-foreground">{replayWarning}</span>
              <button
                type="button"
                onClick={() => setReplayWarning(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}
          {activeRequest ? (
            <RestRequestEditor
              request={activeRequest}
              onChange={handleUpdateRequest}
              envVars={envVarMap}
            />
          ) : (
            <WorkspaceEmptyState
              hasProject={!!selectedProject}
              hasCollection={projectCollections.length > 0}
              onNewRequest={() =>
                projectCollections[0] && handleNewRequest(projectCollections[0].id)
              }
            />
          )}
        </div>
      </div>
      <RestNewRequestDialog
        open={newRequestDialogOpen}
        onClose={() => setNewRequestDialogOpen(false)}
        collections={projectCollections}
        defaultCollectionId={dialogDefaultCollectionId}
        hasProject={!!selectedProject}
        onCreate={handleCreateFromDialog}
        onCreateCollection={handleCreateCollectionFromDialog}
        onCreateProject={handleCreateProjectFromDialog}
      />
      <RestCurlImportDialog
        open={curlImportOpen}
        onClose={() => setCurlImportOpen(false)}
        collections={projectCollections}
        defaultCollectionId={dialogDefaultCollectionId}
        hasProject={!!selectedProject}
        onImport={handleImportFromCurl}
        onCreateCollection={handleCreateCollectionFromDialog}
      />
      <RestHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onReplay={handleReplayFromHistory}
      />
    </div>
  );
}

function WorkspaceEmptyState({
  hasProject,
  hasCollection,
  onNewRequest,
}: {
  hasProject: boolean;
  hasCollection: boolean;
  onNewRequest: () => void;
}) {
  // Create flows live in the sidebar (inline edit rows). Empty state only hints
  // toward the sidebar except for the request shortcut — which already has a
  // collection target on hand, so it stays a one-click button.
  let hint = "Click + Projects in the sidebar to get started";
  let action: { label: string; onClick: () => void } | null = null;
  if (hasProject && !hasCollection) {
    hint = "Click + Collections in the sidebar to add a collection";
  } else if (hasProject && hasCollection) {
    hint = "Click + on a collection to add a request";
    action = { label: "+ New Request", onClick: onNewRequest };
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Globe className="h-10 w-10 opacity-20" />
      <p className="text-sm">No request open</p>
      <p className="text-xs">{hint}</p>
      {action && (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
