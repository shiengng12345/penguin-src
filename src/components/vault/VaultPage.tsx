import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, RefreshCw, X } from "lucide-react";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logger } from "@/lib/logger";
import { requireSuperAdmin } from "@/lib/dev-mode-store";
import { getPersistedValue, hydratePersistedValues } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import { VaultEmptyGate, PENGUIN_GO_HOME_EVENT } from "./VaultEmptyGate";
import {
  VaultSidebar,
  VAULT_SIDEBAR_DEFAULT_WIDTH,
  VAULT_SIDEBAR_MAX_WIDTH,
  VAULT_SIDEBAR_MIN_WIDTH,
  VAULT_SIDEBAR_PERSIST_KEY,
} from "./VaultSidebar";
// VAULT_KIND_RAIL_* tokens are consumed inside VaultMainPanel where
// the rail's ResizableColumn wrapper lives — no need to import them
// at this level.
import { ResizableColumn } from "@/components/ui/resizable-column";
import { VaultMainPanel } from "./VaultMainPanel";
import { VaultCredentialEditor, resolveTemplateIdForKind } from "./VaultCredentialEditor";
import { VaultProjectEditor } from "./VaultProjectEditor";
import { VaultConfirmModal } from "./VaultConfirmModal";
import { loadVaultFromDisk, persistVaultToDisk, parseVaultJson } from "./vault-storage";
import {
  loadLarkUrlFromDisk,
  loadLastSyncedAtFromDisk,
  saveLarkUrl,
  syncVaultFromLark,
} from "./vault-lark";
import { computeVaultDiff } from "./vault-diff";
import { pushToLark, serializeVaultMarkdown, sha256Hex, type PushResult } from "./vault-push";
import { reorderCredentialsByGroup } from "./vault-grouping";
import type {
  VaultCredential,
  VaultProject,
} from "./types";

const LOG_SCOPE = "VaultPage";
const ESCAPE_KEY = "Escape";

interface VaultPageProps {
  onClose: () => void;
}

type CredentialModalState =
  | { open: false }
  | { open: true; mode: "add"; kindHint?: string }
  | { open: true; mode: "edit"; credentialId: string };



// Vault shell (DEC #52 + #54 + #56 + Sprint 3 #92 + Sprint 4 redesign).
// Sprint 4 flattens credentials onto the project — categories removed.
export function VaultPage({ onClose }: VaultPageProps) {
  const { enabled, hasValidToken, isSuperAdmin } = useDeveloperMode();
  const vaultProjects = useAppStore((state) => state.vaultProjects);
  const setVaultProjects = useAppStore((state) => state.setVaultProjects);
  const vaultLarkUrl = useAppStore((state) => state.vaultLarkUrl);
  const vaultLastSyncedAt = useAppStore((state) => state.vaultLastSyncedAt);
  const setVaultLarkUrl = useAppStore((state) => state.setVaultLarkUrl);
  const setVaultIsDirty = useAppStore((state) => state.setVaultIsDirty);

  // Selection lives in the store so switching modules and coming back
  // doesn't drop the user on the first project / default env. Session-
  // only — a fresh app boot resets to null + default below.
  const selectedProjectId = useAppStore((s) => s.vaultSelectedProjectId);
  const setSelectedProjectId = useAppStore((s) => s.setVaultSelectedProjectId);
  const selectedEnvId = useAppStore((s) => s.vaultSelectedEnvId);
  const setSelectedEnvId = useAppStore((s) => s.setVaultSelectedEnvId);

  const [credentialModal, setCredentialModal] = useState<CredentialModalState>({ open: false });
  // When the user presses ✕ on the first-run Lark setup card without
  // having any data, we dismiss the card and show the empty-state view
  // (Add project / secondary Sync from Lark). Previously we dispatched
  // PENGUIN_GO_HOME_EVENT which sent the user away from Vault — confusing.
  const [setupCardDismissed, setSetupCardDismissed] = useState(false);
  const [projectModal, setProjectModal] = useState<{ open: boolean; editingProjectId: string | null }>({
    open: false,
    editingProjectId: null,
  });
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }>({
    open: false,
    title: "",
    message: "",
    confirmLabel: "Delete",
    onConfirm: () => undefined,
  });
  const closeConfirmModal = useCallback((): void => {
    setConfirmModal((prev) => ({ ...prev, open: false }));
  }, []);
  // Push runs inline — no confirm modal. Track pending/error here so the
  // toolbar button can show a spinner and errors fall back to a toast.
  const [isPushing, setIsPushing] = useState<boolean>(false);
  const [pushErrorToast, setPushErrorToast] = useState<{ reason: string; nonce: number } | null>(null);
  // Hydrate Lark URL + last-synced + persisted vault on first mount.
  // Push success toast — short-lived top-center banner so the user gets an
  // explicit "it worked" signal (modal close alone felt silent).
  const [pushSuccessToast, setPushSuccessToast] = useState<{ count: number; nonce: number } | null>(null);
  useEffect(() => {
    const noToast = pushSuccessToast === null;
    if (noToast) return;
    const timer = window.setTimeout(() => setPushSuccessToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [pushSuccessToast]);

  // Push error toast — destructive variant of the success toast; lingers
  // longer (5s) so the user has time to read the underlying reason.
  useEffect(() => {
    const noToast = pushErrorToast === null;
    if (noToast) return;
    const timer = window.setTimeout(() => setPushErrorToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [pushErrorToast]);

  // Undo-after-delete — keeps a snapshot of the projects array prior to the
  // delete, plus a label for the toast. 5s window then auto-dismiss.
  const [undoSnapshot, setUndoSnapshot] = useState<{
    projects: VaultProject[];
    label: string;
    nonce: number;
  } | null>(null);
  useEffect(() => {
    const noUndo = undoSnapshot === null;
    if (noUndo) return;
    const timer = window.setTimeout(() => setUndoSnapshot(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undoSnapshot]);
  const handleUndoDelete = useCallback((): void => {
    const snap = undoSnapshot;
    if (snap === null) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    setVaultProjects(snap.projects);
    setVaultIsDirty(true);
    persistVaultToDisk({ projects: snap.projects });
    setUndoSnapshot(null);
  }, [undoSnapshot, setVaultProjects, setVaultIsDirty]);

  useEffect(() => {
    // Always wait for the full persistence hydration before reading any
    // cached value. If hydratePersistedValues() hasn't resolved yet,
    // getPersistedValue() returns null — causing Vault to look empty even
    // when data exists. Awaiting here guarantees the cache is populated.
    void hydratePersistedValues().then(() => {
      const storedUrl = loadLarkUrlFromDisk();
      const isUrlPresent = storedUrl !== null;
      if (isUrlPresent) setVaultLarkUrl(storedUrl);
      const storedSyncedAt = loadLastSyncedAtFromDisk();
      const isTimestampPresent = storedSyncedAt !== null;
      if (isTimestampPresent) useAppStore.getState().setVaultLastSyncedAt(storedSyncedAt);
      void loadVaultFromDisk();
    });
  }, [setVaultLarkUrl]);

  // Recompute vaultIsDirty whenever vault data changes by comparing the
  // current serialized hash against the last-synced hash on disk. This
  // makes the dirty flag survive dev-server HMR + app restarts — the
  // Zustand flag is transient, but the underlying "current ≠ last push"
  // semantic is durable because both sides are persisted.
  useEffect(() => {
    let cancelled = false;
    const storedContentHash = getPersistedValue(APP_VALUE_KEYS.vaultLastSyncedContentHash);
    const storedHash = storedContentHash ?? getPersistedValue(APP_VALUE_KEYS.vaultLastSyncedHash);
    if (storedHash === null || storedHash === undefined) {
      // No prior sync/push. If the user has projects locally, they're
      // unsynced → dirty. Empty vault → not dirty.
      setVaultIsDirty(vaultProjects.length > 0);
      return;
    }
    const hashInput =
      storedContentHash !== null
        ? JSON.stringify(vaultProjects)
        : serializeVaultMarkdown({ projects: vaultProjects });
    void sha256Hex({ text: hashInput }).then((currentHash) => {
      if (cancelled) return;
      setVaultIsDirty(currentHash !== storedHash);
    });
    return () => {
      cancelled = true;
    };
  }, [vaultProjects, setVaultIsDirty]);

  // Keep selectedProjectId in sync as projects load from disk / sync.
  useEffect(() => {
    const needsFirst = selectedProjectId === null && vaultProjects.length > 0;
    // Auto-select first project once data hydrates.
    if (needsFirst) setSelectedProjectId(vaultProjects[0].id);
  }, [vaultProjects, selectedProjectId]);

  // Auto-correct selectedEnvId when the active project doesn't include the
  // current default.
  useEffect(() => {
    const project = vaultProjects.find((candidate) => candidate.id === selectedProjectId);
    const hasProject = project !== undefined;
    if (!hasProject) return;
    const hasMatchingEnv = project.environments.some((env) => env.id === selectedEnvId);
    const projectHasEnvs = project.environments.length > 0;
    const needsRealign = !hasMatchingEnv && projectHasEnvs;
    // Active project does not include the currently-selected env — fall back to first available.
    if (needsRealign) setSelectedEnvId(project.environments[0].id);
  }, [vaultProjects, selectedProjectId, selectedEnvId]);

  // Defensive auto-close — if Dev Mode is turned off, bounce back to main view.
  useEffect(() => {
    const isStillGated = !enabled;
    // Dev Mode toggled off while Vault was open — bounce user back to main work area.
    if (isStillGated) onClose();
  }, [enabled, onClose]);

  // Esc-to-close — Vault is deliberately NOT in penguin:close-all-dialogs
  // because it is a full-screen view, not a modal (DEC #44).
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      const isEscape = event.key === ESCAPE_KEY;
      // Esc dismisses the full-screen Vault view (not handled by close-all-dialogs).
      if (isEscape) onClose();
    };
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [onClose]);

  // Edit URL — STAGING flow. Clears only the in-memory project list so the
  // setup card surfaces; disk data + locked URL + hash stay intact so the
  // user can bail (X on setup card → loadVaultFromDisk restores) without
  // losing anything. A successful new sync overwrites disk afterward.
  const handleEditUrl = useCallback((): void => {
    logger.info(LOG_SCOPE, "handleEditUrl — staging URL change");
    useAppStore.getState().setVaultProjects([]);
    setVaultIsDirty(false);
  }, [setVaultIsDirty]);

  const activeProject: VaultProject | undefined = vaultProjects.find(
    (project) => project.id === selectedProjectId,
  );

  // Apply a structural mutation to vaultProjects + persist + mark dirty.
  // Single funnel for every CRUD so the dirty flag and disk persist stay in
  // lockstep with in-memory state.
  //
  // IMPORTANT: reads vaultProjects fresh from the store at call time (not
  // via closure). Without this, two saves in quick succession would both
  // mutate the SAME pre-save snapshot and overwrite each other — the
  // bug that produced 4× tangled ArgoCD credentials whose `pairedWith`
  // pointed to the wrong sibling.
  const mutateProjects = useCallback(
    (mutator: (projects: VaultProject[]) => VaultProject[]): void => {
      const isAuthorized = requireSuperAdmin();
      const notAuthorized = !isAuthorized;
      // Defense-in-depth — UI should already hide the entry point.
      if (notAuthorized) {
        logger.warn(LOG_SCOPE, "mutateProjects — not authorized");
        return;
      }
      const current = useAppStore.getState().vaultProjects;
      const next = mutator(current);
      setVaultProjects(next);
      setVaultIsDirty(true);
      const persist = persistVaultToDisk({ projects: next });
      const persistFailed = !persist.success;
      // In-memory updated but disk write failed — log only, keep UI consistent.
      if (persistFailed) {
        logger.warn(LOG_SCOPE, "mutateProjects — in-memory mutated but persist failed");
      }
    },
    [setVaultProjects, setVaultIsDirty],
  );

  const handleAddCredential = useCallback((kindHint?: string): void => {
    const projectId = activeProject?.id;
    const noProject = projectId === undefined;
    // No active project — should never happen because UI hides the button.
    if (noProject) return;
    // kindHint comes from VaultKindRail's selectedKind when the user
    // clicks "Add credential" with a kind filter active. Stored on
    // the modal state so the editor's mount-time prop derivation can
    // resolve it into initialTemplateId + seedKind.
    setCredentialModal({ open: true, mode: "add", kindHint });
  }, [activeProject]);

  const handleEditCredential = useCallback((credentialId: string): void => {
    setCredentialModal({ open: true, mode: "edit", credentialId });
  }, []);

  const handleDeleteCredential = useCallback((credentialId: string): void => {
    const projectId = activeProject?.id;
    const noProject = projectId === undefined;
    // Guarded above by UI conditions — keep this defensive.
    if (noProject) return;
    const credential = activeProject!.credentials.find((cred) => cred.id === credentialId);
    const noTarget = credential === undefined;
    // Stale id — bail without prompting.
    if (noTarget) return;
    setConfirmModal({
      open: true,
      title: `Delete credential`,
      message: `Delete "${credential.name}"?\n\nPush to Lark to make this change durable.`,
      confirmLabel: "Delete credential",
      onConfirm: () => {
        closeConfirmModal();
        const snapshot = vaultProjects;
        const credName = credential.name;
        mutateProjects((projects) =>
          projects.map((project) => {
            const isTargetProject = project.id === projectId;
            if (!isTargetProject) return project;
            return {
              ...project,
              credentials: project.credentials.filter((cred) => cred.id !== credentialId),
            };
          }),
        );
        setUndoSnapshot({ projects: snapshot, label: `Deleted "${credName}"`, nonce: Date.now() });
      },
    });
  }, [activeProject, mutateProjects, closeConfirmModal, vaultProjects]);

  const handleSaveCredential = useCallback((incoming: VaultCredential[]): void => {
    const projectId = activeProject?.id;
    const noProject = projectId === undefined;
    if (noProject) return;
    const state = credentialModal;
    const closed = !state.open;
    if (closed) return;
    const isEdit = state.mode === "edit";
    mutateProjects((projects) =>
      projects.map((project) => {
        const isTargetProject = project.id === projectId;
        if (!isTargetProject) return project;
        // Edit always emits exactly one credential — replace in place.
        // Add can emit N (template bundle) — append all.
        if (isEdit) {
          return {
            ...project,
            credentials: project.credentials.map((cred) => {
              const replacement = incoming.find((c) => c.id === cred.id);
              return replacement ?? cred;
            }),
          };
        }
        // ADD path — defensive id-collision rewrite. The form computed
        // ids using a possibly-stale existingIdsInProject snapshot (e.g.
        // user double-clicks Save or rapidly adds two bundles). Re-check
        // against the CURRENT project's ids; on collision, suffix the
        // new id AND remap any sibling's `pairedWith` reference to it
        // so the bundle stays internally consistent.
        const usedIds = new Set(project.credentials.map((c) => c.id));
        const idRename = new Map<string, string>();
        const rebased: VaultCredential[] = [];
        for (const cred of incoming) {
          let finalId = cred.id;
          if (usedIds.has(finalId)) {
            const base = finalId.replace(/-\d+$/, "");
            let n = 2;
            while (usedIds.has(`${base}-${n}`)) n += 1;
            finalId = `${base}-${n}`;
            idRename.set(cred.id, finalId);
          }
          usedIds.add(finalId);
          rebased.push({ ...cred, id: finalId });
        }
        const remapped =
          idRename.size === 0
            ? rebased
            : rebased.map((c) => {
                if (c.pairedWith !== undefined && idRename.has(c.pairedWith)) {
                  return { ...c, pairedWith: idRename.get(c.pairedWith)! };
                }
                return c;
              });
        return { ...project, credentials: [...project.credentials, ...remapped] };
      }),
    );
    setCredentialModal({ open: false });
  }, [activeProject, credentialModal, mutateProjects]);

  // Toggle the isFavorite flag on a credential. Marks the vault dirty so the
  // change participates in the next push (DEC #94).
  const handleToggleFavorite = useCallback((credentialId: string): void => {
    const projectId = activeProject?.id;
    const noProject = projectId === undefined;
    if (noProject) return;
    mutateProjects((projects) =>
      projects.map((project) => {
        const isTargetProject = project.id === projectId;
        if (!isTargetProject) return project;
        return {
          ...project,
          credentials: project.credentials.map((cred) => {
            const isTarget = cred.id === credentialId;
            if (!isTarget) return cred;
            const next = !(cred.isFavorite ?? false);
            // Omit the field entirely when false so the persisted JSON stays
            // small for credentials the user never starred.
            if (next) return { ...cred, isFavorite: true };
            const { isFavorite: _omit, ...rest } = cred;
            void _omit;
            return rest;
          }),
        };
      }),
    );
  }, [activeProject, mutateProjects]);

  // Add Project — superadmin only. Opens the project editor modal in add
  // mode; saving creates a project with the customized env list + empty
  // credentials.
  const handleAddProject = useCallback((): void => {
    const isAuthorized = requireSuperAdmin();
    const notAuthorized = !isAuthorized;
    // Authz guard — UI hides the button but we revalidate per CRUD entry.
    if (notAuthorized) {
      logger.warn(LOG_SCOPE, "handleAddProject — not authorized");
      return;
    }
    setProjectModal({ open: true, editingProjectId: null });
  }, []);

  // Edit Project — superadmin only. Same editor reused in edit mode;
  // credentials are preserved by the editor's save handler.
  const handleEditProject = useCallback((projectId: string): void => {
    const isAuthorized = requireSuperAdmin();
    const notAuthorized = !isAuthorized;
    if (notAuthorized) {
      logger.warn(LOG_SCOPE, "handleEditProject — not authorized");
      return;
    }
    setProjectModal({ open: true, editingProjectId: projectId });
  }, []);

  const handleSaveProject = useCallback((next: VaultProject): void => {
    const isEdit = projectModal.editingProjectId !== null;
    mutateProjects((projects) => {
      if (isEdit) {
        return projects.map((project) => (project.id === next.id ? next : project));
      }
      return [...projects, next];
    });
    setSelectedProjectId(next.id);
    const firstEnvId = next.environments[0]?.id;
    const hasEnv = firstEnvId !== undefined;
    // Snap env selection so the active tab reflects the new env list.
    if (hasEnv) setSelectedEnvId(firstEnvId);
    setProjectModal({ open: false, editingProjectId: null });
  }, [projectModal.editingProjectId, mutateProjects]);

  // Delete a project — superadmin only. Confirms with credential count to
  // give the user a chance to bail out (blast radius warning per Sam #77).
  const handleDeleteProject = useCallback((projectId: string): void => {
    const isAuthorized = requireSuperAdmin();
    const notAuthorized = !isAuthorized;
    // Authz guard.
    if (notAuthorized) {
      logger.warn(LOG_SCOPE, "handleDeleteProject — not authorized");
      return;
    }
    const target = vaultProjects.find((project) => project.id === projectId);
    const missing = target === undefined;
    // Defensive — UI hides menu for non-existent projects.
    if (missing) return;
    const credCount = target.credentials.length;
    const summary = `Delete "${target.name}"?\n\n${credCount} credential(s) will be permanently removed from this Vault.\nPush to Lark to make the change durable.`;
    setConfirmModal({
      open: true,
      title: `Delete project`,
      message: summary,
      confirmLabel: "Delete project",
      onConfirm: () => {
        closeConfirmModal();
        const snapshot = vaultProjects;
        const projectName = target.name;
        mutateProjects((projects) => projects.filter((project) => project.id !== projectId));
        const isActive = selectedProjectId === projectId;
        if (isActive) {
          const remaining = vaultProjects.filter((project) => project.id !== projectId);
          const nextId = remaining[0]?.id ?? null;
          setSelectedProjectId(nextId);
        }
        setUndoSnapshot({ projects: snapshot, label: `Deleted project "${projectName}"`, nonce: Date.now() });
      },
    });
  }, [vaultProjects, selectedProjectId, mutateProjects, closeConfirmModal]);

  // Switch the active project from the sidebar — and snap selected env to the
  // new project's first env so the breadcrumb pill stays valid.
  const handleSelectProject = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    const project = vaultProjects.find((candidate) => candidate.id === projectId);
    const firstEnvId = project?.environments[0]?.id;
    const hasEnv = firstEnvId !== undefined;
    if (hasEnv) setSelectedEnvId(firstEnvId);
  }, [vaultProjects]);

  // Reorder projects via sidebar drag — order persists to disk + Lark JSON.
  const handleReorderProjects = useCallback((orderedIds: readonly string[]): void => {
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    mutateProjects((projects) => {
      const byId = new Map(projects.map((project) => [project.id, project]));
      const reordered: VaultProject[] = [];
      for (const id of orderedIds) {
        const project = byId.get(id);
        if (project !== undefined) reordered.push(project);
      }
      // Append any project not in the supplied order — defensive guard so a
      // stale ordering payload never drops data.
      for (const project of projects) {
        const isAlreadyEmitted = orderedIds.includes(project.id);
        if (!isAlreadyEmitted) reordered.push(project);
      }
      return reordered;
    });
  }, [mutateProjects]);

  // Sprint 5 — Kinds CRUD. All four handlers mutate the active
  // project's `kinds` array via the existing mutateProjects pipeline,
  // so the change is persisted + push-dirty-flagged + Lark-synced via
  // the same code path as project / credential edits.
  const handleAddKind = useCallback((label: string): void => {
    const projectId = activeProject?.id;
    if (projectId === undefined) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    mutateProjects((projects) => projects.map((project) => {
      if (project.id !== projectId) return project;
      const existing = project.kinds ?? [];
      // Generate a kind id that won't collide with built-ins or with
      // existing entries in this project. Stable enough — kinds are
      // a tiny set per project, no race risk.
      const newId = `kind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return {
        ...project,
        kinds: [...existing, { id: newId, label: trimmed }],
      };
    }));
  }, [activeProject, mutateProjects]);

  const handleRenameKind = useCallback((kindId: string, label: string): void => {
    const projectId = activeProject?.id;
    if (projectId === undefined) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    mutateProjects((projects) => projects.map((project) => {
      if (project.id !== projectId) return project;
      const existing = project.kinds ?? [];
      return {
        ...project,
        kinds: existing.map((k) => (k.id === kindId ? { ...k, label: trimmed } : k)),
      };
    }));
  }, [activeProject, mutateProjects]);

  const handleDeleteKind = useCallback((kindId: string): void => {
    const projectId = activeProject?.id;
    if (projectId === undefined) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    // Block deletion when any credential still references this kind —
    // otherwise the credential becomes an orphan that can't be filtered
    // back into view. Tell the user via window.alert (the only modal
    // we can synchronously gate on without rewriting the confirm flow).
    const project = activeProject;
    if (project === undefined) return;
    const usage = project.credentials.filter((c) => c.kind === kindId).length;
    if (usage > 0) {
      logger.warn(LOG_SCOPE, `handleDeleteKind — refused, ${usage} credential(s) still use kind ${kindId}`);
      window.alert(
        `Can't delete this kind — ${usage} credential${usage === 1 ? "" : "s"} still use it. Move or delete them first.`,
      );
      return;
    }
    mutateProjects((projects) => projects.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.kinds ?? [];
      return { ...p, kinds: existing.filter((k) => k.id !== kindId) };
    }));
  }, [activeProject, mutateProjects]);

  const handleReorderKinds = useCallback((orderedIds: string[]): void => {
    const projectId = activeProject?.id;
    if (projectId === undefined) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    mutateProjects((projects) => projects.map((project) => {
      if (project.id !== projectId) return project;
      const existing = project.kinds ?? [];
      const byId = new Map(existing.map((k) => [k.id, k]));
      const reordered = [];
      for (const id of orderedIds) {
        const kind = byId.get(id);
        if (kind !== undefined) reordered.push(kind);
      }
      // Defensive: append any kind not in the supplied order so a
      // stale payload can't drop data.
      for (const kind of existing) {
        if (!orderedIds.includes(kind.id)) reordered.push(kind);
      }
      return { ...project, kinds: reordered };
    }));
  }, [activeProject, mutateProjects]);

  // Reorder credential groups within the active project. Group internal
  // order is preserved so paired field sequence stays stable.
  const handleReorderCredentials = useCallback((orderedGroupHeadIds: readonly string[]): void => {
    const projectId = activeProject?.id;
    if (projectId === undefined) return;
    const isAuthorized = requireSuperAdmin();
    if (!isAuthorized) return;
    mutateProjects((projects) => projects.map((project) => {
      const isTargetProject = project.id === projectId;
      if (!isTargetProject) return project;
      const credentials = reorderCredentialsByGroup({
        credentials: project.credentials,
        orderedGroupHeadIds: [...orderedGroupHeadIds],
      });
      return { ...project, credentials };
    }));
  }, [activeProject, mutateProjects]);

  // A single push attempt — the doc URL, the hash we expect the remote to still
  // match (null = no prior sync, skip conflict check), and the pre-computed
  // change count used only for the success toast.
  type PushAttempt = { url: string; expectedHash: string | null; changeCount: number };

  // Latest runPush held in a ref so the conflict modal's onConfirm can trigger a
  // retry without runPush referencing itself (which would create a self-dep).
  const runPushRef = useRef<((attempt: PushAttempt) => void) | null>(null);

  // Execute one push and route the outcome: success → toast; conflict → offer an
  // explicit overwrite; any other failure → error toast. The conflict path is
  // what makes a stale-remote recoverable in-app instead of a dead-end toast.
  const runPush = useCallback(async (attempt: PushAttempt): Promise<void> => {
    setIsPushing(true);
    const result = await pushToLark({
      url: attempt.url,
      projects: vaultProjects,
      expectedHash: attempt.expectedHash,
    });
    setIsPushing(false);
    // Push landed — clear the dirty flag and confirm with the change count.
    if (result.success) {
      setVaultIsDirty(false);
      setPushSuccessToast({ count: attempt.changeCount, nonce: Date.now() });
      return;
    }
    // Remote doc changed since our last sync — let the user explicitly overwrite
    // instead of dead-ending on a toast. Re-pushing with the remote hash as the
    // expected baseline makes pushToLark's conflict check pass on the retry.
    const isConflict = result.reason === "conflict";
    if (isConflict) {
      const conflict = result as Extract<PushResult, { reason: "conflict" }>;
      setConfirmModal({
        open: true,
        title: "Lark doc changed since last sync",
        message:
          "The remote doc was edited after your last sync. Overwrite it with your local vault? The remote changes will be lost.",
        confirmLabel: "Overwrite",
        onConfirm: () => {
          closeConfirmModal();
          runPushRef.current?.({
            url: attempt.url,
            expectedHash: conflict.remoteHash,
            changeCount: attempt.changeCount,
          });
        },
      });
      return;
    }
    setPushErrorToast({ reason: result.reason, nonce: Date.now() });
  }, [vaultProjects, setVaultIsDirty, closeConfirmModal]);

  // Keep the ref pointing at the latest runPush for the conflict-retry path.
  useEffect(() => {
    runPushRef.current = (attempt) => {
      void runPush(attempt);
    };
  }, [runPush]);

  // Push entrypoint from the toolbar. Computes the change count + expected hash,
  // then delegates to runPush (which owns success / conflict / error handling).
  const handlePushClick = useCallback(async (): Promise<void> => {
    const isAuthorized = requireSuperAdmin();
    const notAuthorized = !isAuthorized;
    // Push is super-admin only — silently no-op for everyone else (UI hides it).
    if (notAuthorized) return;
    const url = vaultLarkUrl;
    const noUrl = url === null || url.trim().length === 0;
    // No source configured — nothing to push to; surface it via a toast.
    if (noUrl) {
      setPushErrorToast({ reason: "No Lark URL configured.", nonce: Date.now() });
      return;
    }
    // Diff is computed pre-push only so the success toast can show the change
    // count. Disk state is the closest local snapshot of the last sync.
    const persistedRaw = getPersistedValue(APP_VALUE_KEYS.vaultData) ?? "[]";
    const parsed = parseVaultJson({ text: persistedRaw });
    const remoteSnapshot = parsed.success ? parsed.projects : [];
    const diff = computeVaultDiff({ local: vaultProjects, remote: remoteSnapshot });
    const changeCount = diff.added.length + diff.modified.length + diff.deleted.length;
    const expectedHash = getPersistedValue(APP_VALUE_KEYS.vaultLastSyncedHash);
    await runPush({ url, expectedHash, changeCount });
  }, [vaultLarkUrl, vaultProjects, runPush]);


  const credentialModalInitial = useMemo<VaultCredential | null>(() => {
    const isOpen = credentialModal.open;
    if (!isOpen) return null;
    const isEdit = credentialModal.mode === "edit";
    if (!isEdit) return null;
    const cred = activeProject?.credentials.find((c) => c.id === credentialModal.credentialId);
    return cred ?? null;
  }, [credentialModal, activeProject]);

  const credentialModalExistingIds = useMemo<readonly string[]>(() => {
    return activeProject?.credentials.map((c) => c.id) ?? [];
  }, [activeProject]);

  const credentialModalSiblings = useMemo<readonly VaultCredential[]>(() => {
    return activeProject?.credentials ?? [];
  }, [activeProject]);

  // Token gate first — block all Vault content until token is verified.
  if (!hasValidToken) {
    return (
      <div className="flex flex-1 min-h-0 bg-background">
        <VaultEmptyGate />
      </div>
    );
  }

  // No projects in store. Two sub-states:
  //   (a) First-time / never configured — show Lark setup card so the user
  //       can paste a doc URL and sync.
  //   (b) Already used the Vault but currently empty (deleted everything,
  //       or post-sync/post-conflict) — show a friendlier empty state with
  //       Add project + secondary Sync from Lark actions.
  if (vaultProjects.length === 0) {
    const hasUsedVaultBefore = vaultLarkUrl !== null || vaultLastSyncedAt !== null;
    const showFirstRunSetup = !hasUsedVaultBefore && !setupCardDismissed;
    if (showFirstRunSetup) {
      return (
        <div className="flex flex-1 min-h-0 bg-background">
          <VaultLarkSetupCard
            existingUrl={vaultLarkUrl}
            lastSyncedAt={vaultLastSyncedAt}
            onDismiss={() => setSetupCardDismissed(true)}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-1 min-h-0 bg-background">
        <VaultEmptyAfterDelete
          isSuperAdmin={isSuperAdmin}
          larkUrl={vaultLarkUrl}
          onAddProject={isSuperAdmin ? handleAddProject : null}
        />
        <VaultProjectEditor
          open={projectModal.open}
          mode={projectModal.editingProjectId !== null ? "edit" : "add"}
          initialProject={
            projectModal.editingProjectId !== null
              ? vaultProjects.find((p) => p.id === projectModal.editingProjectId) ?? null
              : null
          }
          existingProjectIds={vaultProjects.map((project) => project.id)}
          onCancel={() => setProjectModal({ open: false, editingProjectId: null })}
          onSave={handleSaveProject}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 bg-background">
      {activeProject ? (
        <>
          <ResizableColumn
            defaultWidth={VAULT_SIDEBAR_DEFAULT_WIDTH}
            minWidth={VAULT_SIDEBAR_MIN_WIDTH}
            maxWidth={VAULT_SIDEBAR_MAX_WIDTH}
            persistKey={VAULT_SIDEBAR_PERSIST_KEY}
          >
            <VaultSidebar
              projects={vaultProjects}
              selectedProjectId={activeProject.id}
              selectedEnvId={selectedEnvId}
              onSelectEnv={setSelectedEnvId}
              onClose={onClose}
              onAddProject={isSuperAdmin ? handleAddProject : undefined}
              onSelectProject={handleSelectProject}
              onDeleteProject={isSuperAdmin ? handleDeleteProject : undefined}
              onEditProject={isSuperAdmin ? handleEditProject : undefined}
              onReorderProjects={isSuperAdmin ? handleReorderProjects : undefined}
            />
          </ResizableColumn>
          <VaultMainPanel
            project={activeProject}
            selectedEnvId={selectedEnvId}
            larkUrl={vaultLarkUrl}
            onEditUrl={handleEditUrl}
            onAddCredential={isSuperAdmin ? handleAddCredential : undefined}
            onEditCredential={isSuperAdmin ? handleEditCredential : undefined}
            onDeleteCredential={isSuperAdmin ? handleDeleteCredential : undefined}
            onToggleFavorite={handleToggleFavorite}
            onPush={isSuperAdmin ? handlePushClick : undefined}
            isPushing={isPushing}
            onReorderCredentials={isSuperAdmin ? handleReorderCredentials : undefined}
            onAddKind={isSuperAdmin ? handleAddKind : undefined}
            onRenameKind={isSuperAdmin ? handleRenameKind : undefined}
            onDeleteKind={isSuperAdmin ? handleDeleteKind : undefined}
            onReorderKinds={isSuperAdmin ? handleReorderKinds : undefined}
          />
        </>
      ) : (
        <VaultEmptyGate />
      )}

      <VaultCredentialEditor
        open={credentialModal.open}
        mode={credentialModal.open ? credentialModal.mode : "add"}
        initialCredential={credentialModalInitial}
        environments={activeProject?.environments ?? []}
        existingIdsInProject={credentialModalExistingIds}
        siblingCredentials={credentialModalSiblings}
        onCancel={() => setCredentialModal({ open: false })}
        onSave={handleSaveCredential}
        // Sprint 5 — rail kind pre-fill. If the user clicked "Add
        // credential" with a kind row selected on VaultKindRail,
        // resolveTemplateIdForKind maps the kind hint to a template id
        // (or "custom" + seedKind for kinds without a dedicated
        // multi-field template). When kindHint is undefined the
        // resolver returns undefined and the editor falls back to
        // showing the full picker grid (existing behavior).
        {...(credentialModal.open && credentialModal.mode === "add"
          ? (() => {
              const resolved = resolveTemplateIdForKind(credentialModal.kindHint);
              if (!resolved) return {};
              const kindLabel = credentialModal.kindHint
                ? activeProject?.kinds?.find((k) => k.id === credentialModal.kindHint)?.label
                : undefined;
              return {
                initialTemplateId: resolved.templateId,
                seedKind: resolved.seedKind,
                seedKindLabel: kindLabel,
              };
            })()
          : {})}
      />

      <VaultProjectEditor
        open={projectModal.open}
        mode={projectModal.editingProjectId !== null ? "edit" : "add"}
        initialProject={
          projectModal.editingProjectId !== null
            ? vaultProjects.find((p) => p.id === projectModal.editingProjectId) ?? null
            : null
        }
        existingProjectIds={vaultProjects.map((project) => project.id)}
        onCancel={() => setProjectModal({ open: false, editingProjectId: null })}
        onSave={handleSaveProject}
      />

      <VaultConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmLabel={confirmModal.confirmLabel}
        onCancel={closeConfirmModal}
        onConfirm={confirmModal.onConfirm}
      />

      {pushSuccessToast !== null ? (
        <div
          key={pushSuccessToast.nonce}
          className="pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2 select-none rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-2xl"
        >
          ✓ Pushed to Lark{pushSuccessToast.count > 0 ? ` — ${pushSuccessToast.count} change${pushSuccessToast.count === 1 ? "" : "s"}` : ""}
        </div>
      ) : null}

      {pushErrorToast !== null ? (
        <div
          key={pushErrorToast.nonce}
          className="fixed left-1/2 top-6 z-50 max-w-md -translate-x-1/2 select-text rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-2xl"
        >
          ✗ Push failed — {pushErrorToast.reason}
        </div>
      ) : null}

      {undoSnapshot !== null ? (
        <div
          key={undoSnapshot.nonce}
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm text-foreground shadow-2xl"
        >
          <span>{undoSnapshot.label}</span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Undo / 撤销
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface VaultEmptyAfterDeleteProps {
  isSuperAdmin: boolean;
  larkUrl: string | null;
  onAddProject: (() => void) | null;
}

// Empty state shown when the user previously had projects but currently has
// none (e.g. deleted them all). Primary action is Add project; secondary is
// re-syncing from the existing Lark URL. X button routes to the Home hub
// (Penguin module picker) — same target as the Lark setup card, so the user
// always lands on a stable place from any empty-vault path.
function VaultEmptyAfterDelete(props: VaultEmptyAfterDeleteProps) {
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Inline URL input shown when no Lark URL is configured — lets the user
  // bootstrap a sync from this empty state without bouncing through the setup
  // card flow.
  const [urlInput, setUrlInput] = useState<string>(props.larkUrl ?? "");

  const runSync = useCallback(async (url: string): Promise<void> => {
    setErrorMessage(null);
    setIsSyncing(true);
    saveLarkUrl({ url });
    const result = await syncVaultFromLark({ url });
    setIsSyncing(false);
    const failed = !result.success;
    if (failed) setErrorMessage(result.reason ?? "Sync failed.");
  }, []);

  const handleSync = useCallback(async (): Promise<void> => {
    const trimmed = urlInput.trim();
    const isEmpty = trimmed.length === 0;
    // Block sync until the user pastes a URL — keeps the shell call clean.
    if (isEmpty) {
      setErrorMessage("Paste your Lark / Feishu document URL first.");
      return;
    }
    await runSync(trimmed);
  }, [urlInput, runSync]);

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center p-8">
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-8 shadow-sm">
        <button
          type="button"
          onClick={async () => {
            // Try to restore credentials from disk first — same flow as the
            // setup card. If disk has data, the store refills and Vault
            // naturally re-renders into the credential list view. Only when
            // disk is truly empty do we fall back to the Home hub.
            const result = await loadVaultFromDisk();
            const noDataOnDisk = !result.loaded;
            if (noDataOnDisk) {
              document.dispatchEvent(new CustomEvent(PENGUIN_GO_HOME_EVENT));
            }
          }}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Cancel and restore"
          title="Cancel / 取消"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">No projects</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            还没项目 / Vault is empty.{" "}
            {props.isSuperAdmin
              ? "Add a project to start, or re-sync from Lark to restore."
              : "Ask a superadmin to add a project or sync from Lark."}
          </p>
        </div>

        {props.isSuperAdmin && props.onAddProject !== null ? (
          <Button className="w-full" onClick={props.onAddProject}>
            + Add project
          </Button>
        ) : null}

        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <label className="block text-xs text-muted-foreground">
          Lark Source URL
        </label>
        <Input
          type="url"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="https://your-team.larksuite.com/wiki/..."
          className="mt-1"
          autoComplete="off"
          spellCheck={false}
          disabled={isSyncing}
        />
        <Button
          variant="outline"
          className="mt-3 w-full gap-2"
          onClick={handleSync}
          disabled={isSyncing}
        >
          <RefreshCw className={isSyncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {isSyncing ? "Syncing..." : "Sync from Lark"}
        </Button>

        {errorMessage !== null && (
          <p className="mt-3 text-xs text-destructive">{errorMessage}</p>
        )}
      </div>
    </div>
  );
}

interface VaultLarkSetupCardProps {
  existingUrl: string | null;
  lastSyncedAt: number | null;
  onDismiss?: () => void;
}

// Empty-state setup card: paste Lark URL → save → sync.
function VaultLarkSetupCard(props: VaultLarkSetupCardProps & { onDismiss?: () => void }) {
  const [urlInput, setUrlInput] = useState<string>(props.existingUrl ?? "");
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSync = useCallback(async (): Promise<void> => {
    const trimmed = urlInput.trim();
    const isEmpty = trimmed.length === 0;
    // Block sync until the user pastes something — prevents an empty shell call.
    if (isEmpty) {
      setErrorMessage("Paste your Lark / Feishu document URL first.");
      return;
    }
    setErrorMessage(null);
    setIsSyncing(true);
    saveLarkUrl({ url: trimmed });
    const result = await syncVaultFromLark({ url: trimmed });
    setIsSyncing(false);
    const failed = !result.success;
    // Surface the structured reason from the sync pipeline.
    if (failed) {
      setErrorMessage(result.reason ?? "Sync failed for unknown reason.");
    }
  }, [urlInput]);

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center p-8">
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-8 shadow-sm">
        <button
          type="button"
          onClick={async () => {
            // Wait for the persistence cache to be fully hydrated before
            // loading from disk. On first render the hydratePersistedValues()
            // promise may still be in flight — reading from the in-memory
            // cache before it settles returns null even when data exists,
            // which incorrectly shows "no data" and triggers onDismiss.
            await hydratePersistedValues();
            const result = await loadVaultFromDisk();
            if (!result.loaded) {
              props.onDismiss?.();
            }
          }}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Cancel and restore"
          title="Cancel / 取消"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Penguin Vault</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            从 Lark 文档同步凭据 / Sync credentials from a Lark / Feishu doc.
          </p>
        </div>
        <label className="block text-xs text-muted-foreground">
          Lark Source URL
        </label>
        <Input
          type="url"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="https://your-team.larksuite.com/wiki/..."
          className="mt-1"
          autoComplete="off"
          spellCheck={false}
          disabled={isSyncing}
        />
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          Doc must contain a <code className="rounded bg-muted px-1">```json</code> code block
          matching the VaultProject[] shape.
        </p>
        <Button
          className="mt-5 w-full gap-2"
          onClick={handleSync}
          disabled={isSyncing}
        >
          <RefreshCw className={isSyncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {isSyncing ? "Syncing..." : "Sync from Lark"}
        </Button>
        {errorMessage !== null && (
          <p className="mt-3 text-xs text-destructive">{errorMessage}</p>
        )}
        {props.lastSyncedAt !== null && (
          <p className="mt-3 text-[10px] text-muted-foreground/60">
            Last synced: {new Date(props.lastSyncedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
