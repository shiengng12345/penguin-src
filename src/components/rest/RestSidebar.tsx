// Sprint 10 Phase 10A.8 — REST left sidebar with Projects + Envs + Collections
// stacked vertically. Each section has inline CRUD (+ rename / delete on hover).

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  RestCollection,
  RestEnvVar,
  RestEnvironment,
  RestProject,
  RestRequestRecord,
} from "./rest-types";
import { RestCollectionsTree } from "./RestCollectionsTree";

// All sidebar CRUD now happens via inline input rows, NOT window.prompt —
// Tauri 2 webview blocks browser-native prompt() so the old flow looked
// dead when the user clicked +. Inline edit is the Postman pattern anyway.

export interface RestSidebarProps {
  // Data
  projects: RestProject[];
  environments: RestEnvironment[];
  collections: RestCollection[];
  requests: RestRequestRecord[];
  // Selection
  selectedProjectId: string | null;
  selectedEnvId: string | null;
  activeRequestId: string | null;
  // Search
  search: string;
  onSearchChange: (next: string) => void;
  // Optional ref so the Cmd+F handler in RestPage can focus the search field.
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  // Project handlers — take name string directly (sidebar owns the input UX).
  onSelectProject: (id: string) => void;
  onNewProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  // Env handlers
  onSelectEnv: (id: string | null) => void;
  onNewEnvironment: (name: string) => void;
  onRenameEnvironment: (id: string, name: string) => void;
  onDeleteEnvironment: (id: string) => void;
  // Collection handlers
  onNewCollection: (name: string) => void;
  onDeleteCollection: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  // Request handlers
  onSelectRequest: (id: string) => void;
  onNewRequest: (collectionId: string) => void;
  onDeleteRequest: (id: string) => void;
  // Env var handlers
  envVars: RestEnvVar[];
  onUpsertEnvVar: (v: RestEnvVar) => void;
  onDeleteEnvVar: (id: string) => void;
}

export function RestSidebar(props: RestSidebarProps) {
  // Each section can be collapsed independently. Defaults expanded.
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [envsCollapsed, setEnvsCollapsed] = useState(false);

  // Inline-edit state: exactly one of these holds the active draft at a time.
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingEnv, setCreatingEnv] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renamingEnvId, setRenamingEnvId] = useState<string | null>(null);

  const selectedProject = props.projects.find((p) => p.id === props.selectedProjectId) ?? null;
  const projectEnvironments = selectedProject
    ? props.environments.filter((e) => e.projectId === selectedProject.id)
    : [];
  const projectCollections = selectedProject
    ? props.collections.filter(
        (c) =>
          c.projectId === selectedProject.id &&
          (props.selectedEnvId === null ? c.envId === null : c.envId === props.selectedEnvId),
      )
    : [];

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30">
      {/* Search bar — compact h-9 wrapper. Workspace's name row on
          the right is also h-9 so the first horizontal divider on
          both sides lands at the same Y. */}
      <div className="flex h-9 shrink-0 items-center border-border/60 px-2">
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={props.searchInputRef}
            value={props.search}
            onChange={(e) => props.onSearchChange(e.target.value)}
            placeholder="Search collections (⌘F)"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Projects section */}
      <SidebarSection
        label="Projects"
        collapsed={projectsCollapsed}
        onToggle={() => setProjectsCollapsed((v) => !v)}
        onAdd={() => {
          setProjectsCollapsed(false);
          setCreatingProject(true);
        }}
        addTitle="New project"
      >
        {creatingProject && (
          <InlineEditRow
            placeholder="Project name"
            onCommit={(name) => {
              if (name.trim()) props.onNewProject(name.trim());
              setCreatingProject(false);
            }}
            onCancel={() => setCreatingProject(false)}
            icon={<Folder className="h-3.5 w-3.5 text-violet-500" />}
          />
        )}
        {props.projects.length === 0 && !creatingProject ? (
          <EmptyHint text="No projects — click + to add" />
        ) : (
          props.projects.map((p) => {
            const isActive = p.id === props.selectedProjectId;
            const isRenaming = renamingProjectId === p.id;
            if (isRenaming) {
              return (
                <InlineEditRow
                  key={p.id}
                  initialValue={p.name}
                  placeholder="Project name"
                  onCommit={(name) => {
                    if (name.trim()) props.onRenameProject(p.id, name.trim());
                    setRenamingProjectId(null);
                  }}
                  onCancel={() => setRenamingProjectId(null)}
                  icon={<Folder className="h-3.5 w-3.5 text-violet-500" />}
                />
              );
            }
            return (
              <SidebarRow
                key={p.id}
                isActive={isActive}
                onClick={() => props.onSelectProject(p.id)}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
                <RowActions
                  onRename={() => setRenamingProjectId(p.id)}
                  onDelete={() => props.onDeleteProject(p.id)}
                />
              </SidebarRow>
            );
          })
        )}
      </SidebarSection>

      {/* Environments section — only when a project is selected */}
      {selectedProject && (
        <SidebarSection
          label="Environments"
          collapsed={envsCollapsed}
          onToggle={() => setEnvsCollapsed((v) => !v)}
          onAdd={() => {
            setEnvsCollapsed(false);
            setCreatingEnv(true);
          }}
          addTitle="New environment"
        >
          <SidebarRow
            isActive={props.selectedEnvId === null}
            onClick={() => props.onSelectEnv(null)}
          >
            <span className="ml-5 min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              (no environment)
            </span>
          </SidebarRow>
          {creatingEnv && (
            <InlineEditRow
              placeholder="Env name (DEV / UAT / PROD)"
              onCommit={(name) => {
                if (name.trim()) props.onNewEnvironment(name.trim());
                setCreatingEnv(false);
              }}
              onCancel={() => setCreatingEnv(false)}
              icon={<span className="ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />}
            />
          )}
          {projectEnvironments.length === 0 && !creatingEnv ? (
            <EmptyHint text="No environments — click + to add" />
          ) : (
            projectEnvironments.map((env) => {
              const isActive = env.id === props.selectedEnvId;
              const isRenaming = renamingEnvId === env.id;
              if (isRenaming) {
                return (
                  <InlineEditRow
                    key={env.id}
                    initialValue={env.name}
                    placeholder="Env name"
                    onCommit={(name) => {
                      if (name.trim()) props.onRenameEnvironment(env.id, name.trim());
                      setRenamingEnvId(null);
                    }}
                    onCancel={() => setRenamingEnvId(null)}
                    icon={<span className="ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />}
                  />
                );
              }
              return (
                <SidebarRow
                  key={env.id}
                  isActive={isActive}
                  onClick={() => props.onSelectEnv(env.id)}
                >
                  <span
                    className={cn(
                      "ml-1 inline-block h-2 w-2 shrink-0 rounded-full",
                      isActive ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{env.name}</span>
                  <RowActions
                    onRename={() => setRenamingEnvId(env.id)}
                    onDelete={() => props.onDeleteEnvironment(env.id)}
                  />
                </SidebarRow>
              );
            })
          )}
        </SidebarSection>
      )}

      {/* Environment variables section — key-value table for selected env */}  
      {selectedProject && props.selectedEnvId && (
        <div className="shrink-0 border-b border-border/60 pb-1">
          <div className="flex h-7 items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Variables
            </span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title="Add variable"
              onClick={() => {
                const newVar: RestEnvVar = {
                  id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  scope: "env",
                  scopeId: props.selectedEnvId!,
                  key: "",
                  value: "",
                  isSecret: false,
                  secretHandleId: null,
                  updatedAt: Date.now(),
                };
                props.onUpsertEnvVar(newVar);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-2">
            {props.envVars.length === 0 ? (
              <p className="px-3 py-1.5 text-[11px] text-muted-foreground/70">
                No variables — click + to add
              </p>
            ) : (
              props.envVars.map((v) => (
                <div key={v.id} className="mb-1 flex items-center gap-1.5">
                  <Input
                    value={v.key}
                    onChange={(e) =>
                      props.onUpsertEnvVar({ ...v, key: e.target.value, updatedAt: Date.now() })
                    }
                    placeholder="KEY"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="h-6 w-[40%] text-[10px] font-mono"
                  />
                  <Input
                    value={v.value ?? ""}
                    onChange={(e) =>
                      props.onUpsertEnvVar({ ...v, value: e.target.value, updatedAt: Date.now() })
                    }
                    placeholder="value"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="h-6 flex-1 text-[10px] font-mono"
                  />
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => props.onDeleteEnvVar(v.id)}
                    aria-label="Remove variable"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Collections section — tree of collections + requests. Header
          uses the same h-9 token as SidebarSection so all three
          section headers (Projects / Environments / Collections)
          line up vertically. */}
      {selectedProject && (
        <div className="flex flex-1 min-h-0 flex-col border-t border-border/60">
          <div className="flex h-7 shrink-0 items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Collections
            </span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setCreatingCollection(true)}
              title="New collection"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {creatingCollection && (
            <div className="px-2 pb-1">
              <InlineEditRow
                placeholder="Collection name"
                onCommit={(name) => {
                  if (name.trim()) props.onNewCollection(name.trim());
                  setCreatingCollection(false);
                }}
                onCancel={() => setCreatingCollection(false)}
                icon={<Folder className="h-3.5 w-3.5 text-amber-500" />}
              />
            </div>
          )}
          <RestCollectionsTree
            collections={projectCollections}
            requests={props.requests}
            search={props.search}
            activeRequestId={props.activeRequestId}
            onSelectRequest={props.onSelectRequest}
            onNewRequest={props.onNewRequest}
            onDeleteRequest={props.onDeleteRequest}
            onDeleteCollection={props.onDeleteCollection}
            onRenameCollection={props.onRenameCollection}
          />
        </div>
      )}

      {!selectedProject && (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          Select or create a project to see environments + collections.
        </div>
      )}
    </aside>
  );
}

function SidebarSection({
  label,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
  addTitle: string;
  children: React.ReactNode;
}) {
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="shrink-0 border-border/60">
      {/* Section header — compact h-7 row; the uppercase label is
          small so the section divider doesn't dominate the column.
          User direction: keep the sidebar dense, align the right
          side down to it (not the other way around). */}
      <div className="flex h-7 items-center justify-between px-2">
        <button
          type="button"
          className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          <ChevronIcon className="h-3 w-3" />
          <span>{label}</span>
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={onAdd}
          title={addTitle}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {!collapsed && <div className="pb-1">{children}</div>}
    </div>
  );
}

function SidebarRow({
  isActive,
  onClick,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Compact h-7 row matches the section header above it —
        // keeps the sidebar dense (user direction: don't bloat
        // the left, shrink the right to it).
        "group flex h-7 w-full items-center gap-1.5 px-2 text-left transition-colors",
        isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function RowActions({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <span
        className="text-muted-foreground hover:text-foreground"
        role="button"
        tabIndex={0}
        title="Rename"
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
      >
        <Pencil className="h-3 w-3" />
      </span>
      <span
        className="text-muted-foreground hover:text-destructive"
        role="button"
        tabIndex={0}
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-3 w-3" />
      </span>
    </span>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-3 py-1.5 text-[11px] text-muted-foreground/70">{text}</p>;
}

/// Inline row for creating / renaming a sidebar entry. Auto-focuses on mount,
/// Enter commits the trimmed value, Escape cancels.
function InlineEditRow({
  initialValue = "",
  placeholder,
  onCommit,
  onCancel,
  icon,
}: {
  initialValue?: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  icon: React.ReactNode;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="flex items-center gap-1.5 bg-accent/30 px-2 py-1">
      {icon}
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          // Commit if user typed something; otherwise treat blur as cancel.
          if (value.trim()) onCommit(value);
          else onCancel();
        }}
        className="h-6 flex-1 text-xs"
      />
    </div>
  );
}
