import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  RefreshCw,
  Pencil,
  Plus,
  Upload,
  Search,
  Star,
  MoreVertical,
  Trash2,
  GripVertical,
  Braces,
  MoreHorizontal,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { VaultBrandIcon } from "./VaultBrandIcon";
import { syncVaultFromLark } from "./vault-lark";
import { useAppStore } from "@/lib/store";
import { matchesSearch, highlightSegments, type HighlightSegment } from "./vault-search";
import { buildCredentialGroups } from "./vault-grouping";
import type { VaultCredential, VaultCredentialKind, VaultEnvId, VaultProject } from "./types";
import { writeClipboard } from "@/lib/clipboard";
import {
  VaultKindRail,
  type VaultKindSelection,
  VAULT_KIND_RAIL_DEFAULT_WIDTH,
  VAULT_KIND_RAIL_MAX_WIDTH,
  VAULT_KIND_RAIL_MIN_WIDTH,
  VAULT_KIND_RAIL_PERSIST_KEY,
} from "./VaultKindRail";
import { ResizableColumn } from "@/components/ui/resizable-column";

// Per-card hashed accent color. Same credential.name → same hue across
// renders, so visually distinct cards in a long list (e.g. 18 Redis
// instances) — the eye locks onto the color before reading the text.
// Hue spread is uniform; saturation + lightness chosen to work in
// both light and dark themes without competing with the primary color.
function hashHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

const LOG_SCOPE = "VaultMainPanel";
const COPIED_FEEDBACK_MS = 1500;

type ActiveTab = "all" | "favorites";

interface VaultMainPanelProps {
  project: VaultProject;
  selectedEnvId: VaultEnvId;
  larkUrl: string | null;
  onEditUrl: () => void;
  // Sprint 3 — superadmin CRUD hooks. All optional; UI omits the controls
  // when the parent does not wire them.
  onAddCredential?: (kindHint?: string) => void;
  onEditCredential?: (credentialId: string) => void;
  onDeleteCredential?: (credentialId: string) => void;
  // Sprint 4 — Favorites toggle. Wired unconditionally; non-superadmins can
  // still star locally (dirty flag handles the push gate).
  onToggleFavorite: (credentialId: string) => void;
  onPush?: () => void;
  isPushing?: boolean;
  // Superadmin drag-to-reorder. Receives the new ordered list of group-head
  // credential ids after a drop completes.
  onReorderCredentials?: (orderedGroupHeadIds: readonly string[]) => void;
  // Sprint 5 — Kinds CRUD. Forwarded to VaultKindRail; undefined hides
  // the corresponding affordance (non-super-admin viewer).
  onAddKind?: (label: string) => void;
  onRenameKind?: (id: string, label: string) => void;
  onDeleteKind?: (id: string) => void;
  onReorderKinds?: (orderedIds: string[]) => void;
}

// Right pane of the Vault page. Sprint 4 flat list view + All/Favorites tabs
// + fuzzy/wildcard search. Toolbar carries sync / push + Add credential.
export function VaultMainPanel(props: VaultMainPanelProps) {
  const { project, selectedEnvId, larkUrl, onEditUrl, onToggleFavorite } = props;
  const { isSuperAdmin } = useDeveloperMode();
  const activeEnv = project.environments.find((env) => env.id === selectedEnvId);
  const setVaultLastSyncedAt = useAppStore((state) => state.setVaultLastSyncedAt);
  const setVaultIsDirty = useAppStore((state) => state.setVaultIsDirty);
  const vaultIsDirty = useAppStore((state) => state.vaultIsDirty);
  // Full vault — used by the Copy JSON action so the user grabs the exact
  // payload that would be pushed to Lark, not just the active project.
  const vaultProjects = useAppStore((state) => state.vaultProjects);

  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  // Middle-column kind filter — single-select, "all" by default. Lives
  // local (no Zustand) to match the existing Vault precedent: activeTab
  // / searchQuery / selectedEnvId / selectedProjectId are all local
  // useState. Reset on remount is acceptable; users typed in-session.
  const [selectedKind, setSelectedKind] = useState<VaultKindSelection>("all");
  // Floating "Copied!" toast — rendered at the cursor position so the
  // feedback is impossible to miss (right-side icon was too far from the eye).
  const [copyToast, setCopyToast] = useState<{ x: number; y: number; nonce: number } | null>(null);

  useEffect(() => {
    const noToast = copyToast === null;
    if (noToast) return;
    const timer = window.setTimeout(() => setCopyToast(null), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyToast]);

  const handleCopyAt = useCallback(async (payload: { value: string; x: number; y: number }): Promise<void> => {
    try {
      await writeClipboard(payload.value);
    } catch (error) {
      logger.error(LOG_SCOPE, "handleCopyAt — clipboard write failed", error);
      return;
    }
    setCopyToast({ x: payload.x, y: payload.y, nonce: Date.now() });
  }, []);

  const handleSync = useCallback(async (): Promise<void> => {
    const isUrlMissing = larkUrl === null || larkUrl.trim().length === 0;
    // Block sync if URL has been cleared somehow — should not happen in normal flow.
    if (isUrlMissing) {
      logger.warn(LOG_SCOPE, "handleSync — no Lark URL configured");
      setSyncError("No Lark URL configured.");
      return;
    }
    const wouldDiscardEdits = vaultIsDirty;
    // Sprint 3 DEC #90 — sync overwrites local state; block when dirty.
    if (wouldDiscardEdits) {
      logger.warn(LOG_SCOPE, "handleSync — local edits present, refusing");
      setSyncError("Unsaved local edits — push first or revert before sync.");
      return;
    }
    setSyncError(null);
    setIsSyncing(true);
    const result = await syncVaultFromLark({ url: larkUrl });
    setIsSyncing(false);
    const failed = !result.success;
    // Surface the structured reason so the user knows whether it was auth,
    // parse, or shape that broke.
    if (failed) {
      setSyncError(result.reason ?? "Sync failed for unknown reason.");
      return;
    }
    setVaultLastSyncedAt(Date.now());
    setVaultIsDirty(false);
  }, [larkUrl, setVaultLastSyncedAt, setVaultIsDirty, vaultIsDirty]);

  // Copy the full vault as pretty-printed JSON — same shape pushed to Lark.
  // Routed through handleCopyAt so the cursor toast feedback stays consistent.
  const handleCopyJson = useCallback(async (event: React.MouseEvent): Promise<void> => {
    const json = JSON.stringify(vaultProjects, null, 2);
    await handleCopyAt({ value: json, x: event.clientX, y: event.clientY });
  }, [vaultProjects, handleCopyAt]);

  // Single source of truth for grouping — every downstream computation
  // (tab counts, visible list, drag reorder) reads from this one memo so
  // buildCredentialGroups runs exactly once per credentials change.
  const allGroups = useMemo(() => buildCredentialGroups(project.credentials), [project.credentials]);
  const allCount = allGroups.length;
  const favoritesCount = useMemo<number>(() => {
    return allGroups.filter((group) => group.some((cred) => cred.isFavorite === true)).length;
  }, [allGroups]);

  // Per-kind group counts powering the rail's badges. HEAD-kind only —
  // a paired group (e.g. database+token from the "database" template)
  // counts ONCE under its primary kind, matching the badge shown on
  // the card itself (VaultMainPanel renders `primary.kind` verbatim).
  const countsByKind = useMemo<Partial<Record<VaultCredentialKind, number>>>(() => {
    const out: Partial<Record<VaultCredentialKind, number>> = {};
    for (const group of allGroups) {
      const headKind = group[0]?.kind;
      if (!headKind) continue;
      out[headKind] = (out[headKind] ?? 0) + 1;
    }
    return out;
  }, [allGroups]);

  // Filter pipeline runs at GROUP level so paired credentials never split —
  // favorites tab shows the whole pair when any member is starred; search
  // matching any field surfaces the whole pair. Kind filter inserts
  // BEFORE search so the search box can still narrow within the kind.
  const visibleGroups = useMemo<VaultCredential[][]>(() => {
    const kindFiltered = selectedKind === "all"
      ? allGroups
      : allGroups.filter((group) => group[0]?.kind === selectedKind);
    const tabFiltered = activeTab === "favorites"
      ? kindFiltered.filter((group) => group.some((cred) => cred.isFavorite === true))
      : kindFiltered;
    const trimmedQuery = searchQuery.trim();
    const hasQuery = trimmedQuery.length > 0;
    if (!hasQuery) return tabFiltered;
    return tabFiltered.filter((group) =>
      group.some((cred) =>
        matchesSearch({
          query: trimmedQuery,
          credential: cred,
          envValue: cred.valueByEnv[selectedEnvId] ?? "",
        }),
      ),
    );
  }, [allGroups, activeTab, searchQuery, selectedEnvId, selectedKind]);

  const canReorder = isSuperAdmin && props.onReorderCredentials !== undefined;

  // dnd-kit sensors — 8px activation distance so casual clicks on the row
  // body / favorite star / value buttons don't kick off a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleSortableDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    const noTarget = over === null || active.id === over.id;
    if (noTarget) return;
    // Reorder against the FULL unfiltered group order (memoized above) so an
    // active search/tab filter does not corrupt the persisted sequence.
    const headOrder = allGroups.map((group) => group[0].id);
    const oldIndex = headOrder.indexOf(String(active.id));
    const newIndex = headOrder.indexOf(String(over.id));
    const isMissing = oldIndex === -1 || newIndex === -1;
    if (isMissing) return;
    const reordered = arrayMove(headOrder, oldIndex, newIndex);
    props.onReorderCredentials?.(reordered);
    logger.info(LOG_SCOPE, "handleSortableDragEnd — reordered", { oldIndex, newIndex });
  };

  return (
    // Fragment so VaultKindRail and the existing <section> become two
    // siblings of VaultPage's flex row — sidebar | rail | section.
    // Keeping the rail wired inside MainPanel (instead of lifting to
    // VaultPage) means selectedKind + countsByKind + the kind-aware
    // visibleGroups memo all stay together; no prop drilling.
    <>
      <ResizableColumn
        defaultWidth={VAULT_KIND_RAIL_DEFAULT_WIDTH}
        minWidth={VAULT_KIND_RAIL_MIN_WIDTH}
        maxWidth={VAULT_KIND_RAIL_MAX_WIDTH}
        persistKey={VAULT_KIND_RAIL_PERSIST_KEY}
      >
        <VaultKindRail
          kinds={project.kinds ?? []}
          counts={countsByKind}
          allCount={allCount}
          selectedKind={selectedKind}
          onSelectKind={setSelectedKind}
          onAddKind={props.onAddKind}
          onRenameKind={props.onRenameKind}
          onDeleteKind={props.onDeleteKind}
          onReorderKinds={props.onReorderKinds}
        />
      </ResizableColumn>
      <section className="flex flex-1 min-w-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-foreground">{project.name}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium",
            )}
          >
            {activeEnv ? (
              <span className={cn("h-2 w-2 rounded-full", activeEnv.color)} />
            ) : null}
            <span>{activeEnv?.name ?? selectedEnvId}</span>
          </span>
          {vaultIsDirty ? (
            <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
              ● Unsaved
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={handleSync}
            disabled={isSyncing || vaultIsDirty}
            title={vaultIsDirty ? "Resolve unsaved edits before re-syncing" : "Re-fetch credentials from Lark source"}
          >
            <RefreshCw className={isSyncing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {isSyncing ? "Syncing..." : "Sync"}
          </Button>
          {isSuperAdmin ? (
            <Button
              size="sm"
              variant="default"
              className="gap-1"
              onClick={props.onPush}
              disabled={!vaultIsDirty || props.onPush === undefined || props.isPushing === true}
              title={vaultIsDirty ? "Push local edits to Lark" : "No local edits to push"}
            >
              {props.isPushing === true ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {props.isPushing === true ? "Pushing..." : "Push"}
            </Button>
          ) : null}
          <ToolbarOverflowMenu onCopyJson={handleCopyJson} onEditUrl={onEditUrl} />
        </div>
      </div>

      {syncError !== null && (
        <p className="px-6 pb-2 text-xs text-destructive">{syncError}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-6 pb-3">
        <div className="flex items-center gap-1">
          <TabButton
            label="All"
            count={allCount}
            active={activeTab === "all"}
            onClick={() => setActiveTab("all")}
          />
          <TabButton
            label="Favorites"
            count={favoritesCount}
            active={activeTab === "favorites"}
            onClick={() => setActiveTab("favorites")}
          />
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className="h-8 pl-7 text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {isSuperAdmin && props.onAddCredential !== undefined ? (
            <Button
              size="sm"
              className="gap-1"
              // Forward the active rail kind so the credential editor
              // can pre-select the matching template + lock the kind.
              // "all" → no hint, falls through to the picker grid.
              onClick={() => props.onAddCredential?.(selectedKind === "all" ? undefined : selectedKind)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add credential
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {project.credentials.length === 0 ? (
          <EmptyState
            isSuperAdmin={isSuperAdmin}
            onAddCredential={props.onAddCredential}
          />
        ) : visibleGroups.length === 0 ? (
          <FilteredEmpty activeTab={activeTab} searchQuery={searchQuery} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSortableDragEnd}>
            <SortableContext
              items={visibleGroups.map((group) => group[0].id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-4">
                {visibleGroups.map((group, groupIndex) => (
                  <SortableCredentialRow
                    key={group[0].id + "-" + groupIndex}
                    group={group}
                    selectedEnvId={selectedEnvId}
                    searchQuery={searchQuery}
                    onEdit={props.onEditCredential}
                    onDelete={props.onDeleteCredential}
                    onToggleFavorite={onToggleFavorite}
                    onCopyAt={handleCopyAt}
                    canReorder={canReorder}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
      {copyToast !== null ? (
        <div
          key={copyToast.nonce}
          className="pointer-events-none fixed z-50 select-none rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white shadow-lg"
          style={{ left: copyToast.x + 12, top: copyToast.y - 28 }}
        >
          ✓ Copied
        </div>
      ) : null}
    </section>
    </>
  );
}

interface TabButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function TabButton(props: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
        props.active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      <span>{props.label}</span>
      <span className={cn(
        "rounded-full px-1.5 py-0 text-[10px]",
        props.active ? "bg-primary/20 text-primary" : "bg-muted/60 text-muted-foreground",
      )}>
        {props.count}
      </span>
    </button>
  );
}

interface ToolbarOverflowMenuProps {
  onCopyJson: (event: React.MouseEvent) => void;
  onEditUrl: () => void;
}

// Low-frequency actions (Copy JSON, Edit URL) collapsed behind a kebab so the
// toolbar surfaces only the Sync / Push primary actions.
function ToolbarOverflowMenu(props: ToolbarOverflowMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const isClosed = !isOpen;
    if (isClosed) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      const isOutside = wrapperRef.current !== null && target !== null && !wrapperRef.current.contains(target);
      if (isOutside) setIsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="More toolbar actions"
        title="More actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {isOpen ? (
        <div className="absolute right-0 top-9 z-30 w-44 rounded-md border border-border bg-popover py-1 shadow-lg">
          <button
            type="button"
            onClick={(event) => {
              setIsOpen(false);
              props.onCopyJson(event);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted/50"
          >
            <Braces className="h-3.5 w-3.5" />
            Copy JSON
          </button>
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              props.onEditUrl();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted/50"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit Lark URL
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  isSuperAdmin: boolean;
  onAddCredential?: (kindHint?: string) => void;
}

function EmptyState(props: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/40 text-muted-foreground">
        <Plus className="h-5 w-5" />
      </div>
      <h2 className="text-sm font-semibold text-foreground">No credentials yet</h2>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        {props.isSuperAdmin && props.onAddCredential !== undefined
          ? "Add your first credential, or pull from Lark."
          : "Only superadmins can create credentials. Ask one to set this project up."}
      </p>
      {props.isSuperAdmin && props.onAddCredential !== undefined ? (
        // Wrap in an arrow so onClick doesn't pass the MouseEvent as
        // kindHint. EmptyState has no rail context (it only renders
        // when project.credentials.length === 0), so no kind to
        // forward — pass undefined and let the editor fall through
        // to the picker grid.
        <Button size="sm" className="mt-4 gap-1" onClick={() => props.onAddCredential?.()}>
          <Plus className="h-3.5 w-3.5" />
          Add credential
        </Button>
      ) : null}
    </div>
  );
}

interface FilteredEmptyProps {
  activeTab: ActiveTab;
  searchQuery: string;
}

function FilteredEmpty(props: FilteredEmptyProps) {
  const noMatch = props.searchQuery.trim().length > 0;
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center">
      <p className="text-sm text-muted-foreground">
        {noMatch
          ? `No credentials match "${props.searchQuery}".`
          : props.activeTab === "favorites"
            ? "No favorites yet. Click the ☆ on any row to star it."
            : "No credentials to show."}
      </p>
    </div>
  );
}

interface CredentialRowProps {
  group: VaultCredential[];
  selectedEnvId: VaultEnvId;
  // Empty string = search inactive, no highlight wraps emitted.
  searchQuery: string;
  onEdit?: (credentialId: string) => void;
  onDelete?: (credentialId: string) => void;
  onToggleFavorite: (credentialId: string) => void;
  onCopyAt: (payload: { value: string; x: number; y: number }) => void;
}

interface SortableCredentialRowProps extends CredentialRowProps {
  canReorder: boolean;
}

// Sortable wrapper that owns the dnd-kit hook and forwards bindings to the
// presentational CredentialRow. Splits state-from-presentation so the row
// itself stays simple and testable.
function SortableCredentialRow(props: SortableCredentialRowProps) {
  const headId = props.group[0].id;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: headId, disabled: !props.canReorder });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <CredentialRow
        {...props}
        dragHandleAttributes={props.canReorder ? attributes : undefined}
        dragHandleListeners={props.canReorder ? listeners : undefined}
      />
    </div>
  );
}

interface CredentialRowFullProps extends CredentialRowProps {
  // dnd-kit binds — handed through from the SortableCredentialRow wrapper so
  // only the grip handle responds to drag, never the body / star / value.
  dragHandleAttributes?: ReturnType<typeof useSortable>["attributes"];
  dragHandleListeners?: ReturnType<typeof useSortable>["listeners"];
}

// Single list row for one credential group (1 cred standalone, N creds paired).
function CredentialRow(props: CredentialRowFullProps) {
  const { group, selectedEnvId, onEdit, onDelete, onToggleFavorite, onCopyAt } = props;
  const { isSuperAdmin } = useDeveloperMode();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const primary = group[0];
  const isFavorite = primary.isFavorite === true;
  const showAdminMenu = isSuperAdmin && (onEdit !== undefined || onDelete !== undefined);

  useEffect(() => {
    const isClosed = !isMenuOpen;
    if (isClosed) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      const isOutside = menuRef.current !== null && target !== null && !menuRef.current.contains(target);
      if (isOutside) setIsMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isMenuOpen]);

  const handleCopy = (credential: VaultCredential, event: React.MouseEvent): void => {
    const value = credential.valueByEnv[selectedEnvId] ?? "";
    // Cursor coords drive the floating toast in the parent — no need for an
    // inline "Copied!" badge anymore.
    onCopyAt({ value, x: event.clientX, y: event.clientY });
  };

  const canDrag = props.dragHandleListeners !== undefined;
  // Hashed accent color — same credential always paints the same hue,
  // so 18 Redis cards in a row become visually distinct without
  // changing layout.
  const accentHue = hashHue(primary.name);
  const accentColor = `hsl(${accentHue}, 60%, 55%)`;

  return (
    <div
      className="group rounded-xl border-2 border-border bg-card shadow-lg ring-1 ring-border/40 transition-colors hover:border-primary/60"
      // Solid left border in the credential's hashed color — wide
      // enough to read at a glance, low enough saturation to not
      // dominate the card. Falls back invisibly when hue computation
      // can't run (e.g. SSR snapshot).
      style={{ borderLeftColor: accentColor, borderLeftWidth: "6px" }}
    >
      <div className="flex h-11 items-center gap-2 rounded-t-[0.625rem] border-b border-border bg-muted/30 px-3">
        {canDrag ? (
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground active:cursor-grabbing"
            aria-label="Drag to reorder"
            title="Drag to reorder"
            {...props.dragHandleAttributes}
            {...props.dragHandleListeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onToggleFavorite(primary.id)}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            isFavorite
              ? "text-amber-400 hover:text-amber-500"
              : "text-muted-foreground/60 hover:text-amber-400",
          )}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Star className={cn("h-3.5 w-3.5", isFavorite ? "fill-current" : "")} />
        </button>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <VaultBrandIcon kind={primary.kind} className="h-3.5 w-3.5" />
        </div>
        <span className="truncate text-sm font-semibold text-foreground">
          <HighlightedText query={props.searchQuery} text={primary.name} />
        </span>
        <span className="rounded-md bg-muted/40 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {primary.kind}
        </span>
        <div className="flex-1" />
        {showAdminMenu ? (
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              aria-label="Admin actions"
              title="Admin actions"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
            {isMenuOpen ? (
              <div className="absolute right-0 top-7 z-30 w-52 rounded-md border border-border bg-popover py-1 shadow-lg">
                {group.map((cred, idx) => (
                  <div key={cred.id}>
                    {idx > 0 ? <div className="my-1 h-px bg-border/60" /> : null}
                    <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {cred.name}
                    </div>
                    {onEdit !== undefined ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted/50"
                        onClick={() => {
                          setIsMenuOpen(false);
                          onEdit(cred.id);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                    ) : null}
                    {onDelete !== undefined ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setIsMenuOpen(false);
                          onDelete(cred.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-border/50">
        {group.map((cred) => (
          <FieldInlineRow
            key={cred.id}
            credential={cred}
            displayValue={cred.valueByEnv[selectedEnvId] ?? ""}
            searchQuery={props.searchQuery}
            onCopy={(event) => handleCopy(cred, event)}
          />
        ))}
      </div>
    </div>
  );
}

interface FieldInlineRowProps {
  credential: VaultCredential;
  displayValue: string;
  searchQuery: string;
  // Click handler receives the React mouse event so the parent can position
  // the floating "Copied!" toast at the cursor location.
  onCopy: (event: React.MouseEvent) => void;
}

// Wraps matched chunks of `text` in <mark> so the user sees exactly which
// chars the fuzzy / wildcard match landed on. Empty query short-circuits to
// the raw string.
function HighlightedText(props: { query: string; text: string }) {
  const segments: HighlightSegment[] = highlightSegments({ query: props.query, text: props.text });
  return (
    <>
      {segments.map((seg, idx) =>
        seg.match ? (
          <mark
            key={idx}
            className="rounded-sm bg-amber-400/40 px-0.5 text-foreground"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// Recognize values that look like URLs so we can render them as clickable
// and route the click to the OS browser via the Tauri shell plugin.
const URL_REGEX = /^https?:\/\//i;

async function openInBrowser(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch (error) {
    logger.error(LOG_SCOPE, "openInBrowser — failed", error);
  }
}

// Fixed-height field row so every card paints to the same vertical rhythm —
// a 2-field card is exactly 2× a 1-field card, no padding wobble. Per-row
// separator comes from the parent `divide-y` so the last row has no border.
// Right-side copy icon was dropped — the value text itself is the click
// target, feedback appears at the cursor.
function FieldInlineRow(props: FieldInlineRowProps) {
  const fieldLabel = KIND_FIELD_LABEL[props.credential.kind];
  const trimmedValue = props.displayValue.trim();
  const isUrl = URL_REGEX.test(trimmedValue);
  return (
    <div className="flex h-9 items-center gap-3 px-3">
      <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {fieldLabel}
      </span>
      <div
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={props.displayValue}
      >
        {props.displayValue ? (
          isUrl ? (
            <button
              type="button"
              onClick={() => openInBrowser(trimmedValue)}
              className="block w-full truncate text-left text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              title={`Open in browser: ${trimmedValue}`}
            >
              <HighlightedText query={props.searchQuery} text={props.displayValue} />
            </button>
          ) : (
            <button
              type="button"
              onClick={props.onCopy}
              className="block w-full truncate text-left text-foreground/80 transition-colors hover:text-foreground hover:bg-muted/30 rounded px-1 -mx-1"
              title="Click to copy"
            >
              <HighlightedText query={props.searchQuery} text={props.displayValue} />
            </button>
          )
        ) : (
          <span className="italic text-muted-foreground/60">no value</span>
        )}
      </div>
    </div>
  );
}

const KIND_FIELD_LABEL: Record<string, string> = {
  link: "URL",
  token: "Token",
  database: "URI",
  cache: "Host",
  generic: "Value",
  vault: "Endpoint",
  argocd: "Endpoint",
  monitoring: "Endpoint",
  web: "URL",
  api: "Endpoint",
  login: "URL",
};
