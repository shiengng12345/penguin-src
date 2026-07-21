# Runtime Manager — Prevent Sleep (Design Spec)

Date: 2026-07-21
Branch: `feature/runtime-manager-prevent-sleep`
Status: Approved design, pending implementation plan

## 1. Goal

Let Penguin automatically prevent the OS from sleeping while long-running dev
work is active (Flow runs, local backends, Docker, long AI tasks), and release
that hold automatically when nothing needs it anymore. The technical mechanism
(`caffeinate`) is never exposed in the UI — it is presented as a
developer-friendly **Prevent Sleep** runtime capability.

The Runtime Manager is designed as a generic runtime controller so future
runtime services (Docker, Redis, PostgreSQL, backends, VPN, AI Worker, MCP
server, tunnels, queue workers, …) can register into the same panel without
refactoring Prevent Sleep.

## 2. Architecture

```
React status-bar icon + popover panel + Settings section
        │  invoke()
        ▼
Tauri commands (runtime::*)
        │
        ▼
RuntimeManager  (reference counting + lifecycle transitions, platform-agnostic)
        │  Arc<dyn SleepController>
        ▼
macOS: MacosCaffeinateController   |   win/linux: UnsupportedSleepController
```

Platform-specific code is isolated entirely inside `SleepController`
implementations. `RuntimeManager` owns only logical state (per-source counts,
total, active flag, cached policy) and lifecycle transitions — it never touches
processes directly.

## 3. UI / UX

### 3.1 Placement — status bar, not main sidebar

Runtime is background status, not a workspace, so it lives in the bottom-right
status bar (alongside the existing notification / sync / settings icons), NOT
as a left-rail main module.

- A new **Runtime icon** (☕ / runtime glyph) sits in the status bar.
- The icon doubles as a **state indicator**: dim when Prevent Sleep is off, lit
  when on. Tooltip on hover, e.g. `Prevent Sleep · Enabled (Flow, AI)`.

### 3.2 Popover panel

Clicking the icon opens a compact popover above the status bar (does not take
over the screen):

```
┌─────────────────────────────┐
│  Runtime                     │
│  🟢 Backend        Running   │
│  ☕ Prevent Sleep  [ ●] On   │  ← toggle
│  🐳 Docker         Running   │
│  🧠 AI Worker      Idle      │
│  🔐 VPN            Connected │
│  Prevent this computer from  │
│  sleeping while Penguin runs.│
│  ⚙ Runtime Settings →        │
└─────────────────────────────┘
```

- Toggling **Prevent Sleep** fires a toast: `☕ Prevent Sleep Enabled` /
  `☕ Prevent Sleep Disabled`.
- Footer link opens **Settings → Runtime**.
- Click-outside dismisses.
- Other rows (Backend / Docker / AI Worker / VPN) are read-only status
  indicators; Prevent Sleep is the only interactive item in v1. Non-wired
  sources show placeholder status until their real source is connected.

### 3.3 Settings → Runtime

Prevent Sleep mode (single select):

- ( ) Never
- ( ) Ask Every Time
- (•) Automatically when Penguin starts
- ( ) Automatically while Flow is executing
- ( ) Automatically while Backend is running
- ( ) Automatically while AI Agent is working

Automatic conditions are combinable (multiple checked at once, e.g. Flow + AI).

### 3.4 Constraints

- The words `caffeinate` / any command line MUST NEVER appear in the UI.
- When an auto condition activates Prevent Sleep, the status-bar icon lights up
  (transparent automation — user sees the system acted on their behalf).

## 4. Rust backend

New module `src-tauri/src/runtime/` following the `redis/` convention
(`mod.rs` + `commands.rs` + supporting files), state registered via
`.manage(...)` in `lib.rs`.

### 4.1 Platform abstraction — `SleepController`

Process handle is owned by the controller (not the manager). Trait is async and
idempotent.

```rust
#[async_trait::async_trait]
pub trait SleepController: Send + Sync {
    async fn engage(&self)  -> Result<(), RuntimeError>; // idempotent: no-op if already active
    async fn release(&self) -> Result<(), RuntimeError>; // idempotent: no-op if already released
    async fn is_active(&self) -> bool;
    async fn shutdown(&self) -> Result<(), RuntimeError> { self.release().await }
}
```

- **macOS** — `MacosCaffeinateController { child: Mutex<Option<Child>> }`.
  `engage` spawns `caffeinate -di -w <penguin_pid>` once (the `-w` binds
  caffeinate's lifetime to Penguin's PID, so a Penguin crash auto-kills
  caffeinate — no orphans). `release` does graceful terminate
  (SIGTERM → wait → bounded SIGKILL fallback) then clears the child.
- **win/linux** — `UnsupportedSleepController` returns an explicit `Unsupported`
  status (does NOT fake success). Refcount bookkeeping still runs
  deterministically. Future `PowerSetRequest` (Windows) / `systemd-inhibit`
  (Linux) impls drop in without touching business logic.
- Controller is selected at module level via `#[cfg(target_os = ...)]`, not at
  call sites.

### 4.2 Reference counting + lifecycle — `RuntimeManager`

```rust
pub struct RuntimeManager {
    controller: Arc<dyn SleepController>,
    state: tokio::sync::Mutex<RuntimeManagerState>, // per_source, total, active, shutting_down, cached_policy
    transition: tokio::sync::Mutex<()>,             // single-flight guard for 0<->1 transitions
}
```

Sources: `RuntimeSource { Flow, Backend, Ai, Docker, Manual }`.

- All count changes go through one `apply_delta(source, ±1)`. The 0↔1 total
  transition is computed and executed **inside the `transition` lock**, so
  concurrent registers trigger exactly one `engage`, and concurrent
  unregisters-to-zero trigger exactly one `release`. Returns
  `RuntimeTransition { Noop, Engaged, Released, Failed }`.
- The two-lock split (short `state` edits vs. serialized `transition`) prevents
  the TOCTOU race between checking the count and spawning/killing.
- Count safety: per-source `u32`, `saturating_add` / `checked_sub`. Unregister
  without a prior register is ignored with a warning (no underflow).
- `Manual` is boolean semantics (`set_manual(bool)`). "Ask Every Time" creates a
  one-shot `Manual` activation after user confirmation and auto-releases at the
  operation boundary — it does NOT mutate the durable auto policy.
- On controller error: state stays consistent, a recoverable `RuntimeError` is
  returned; never panic / never poison a lock (does not repeat existing modules'
  `unwrap`-on-guard habit).

### 4.3 Policy caching (no DB in hot path)

- On startup, load the policy (mode + auto conditions) into the manager's
  in-memory cache. `runtime_set_mode` refreshes the cache when settings change.
- Flow/Backend start/stop hot paths only read the in-memory cache + check source
  membership — **no synchronous SQLite IO** in these paths.

### 4.4 Commands (`runtime/commands.rs`)

- `runtime_get_status` → `{ prevent_sleep, platform_supported, sources:[{source,count}], mode, auto_conditions }` (plus placeholder Backend/Docker/AI/VPN indicators)
- `runtime_set_prevent_sleep(enabled)` — manual toggle (= `set_manual`)
- `runtime_set_mode(mode, auto_conditions)`
- `runtime_register_source(source)` / `runtime_unregister_source(source)` — used by auto mode

### 4.5 Wiring (`lib.rs`)

- `mod runtime;`, `.manage(RuntimeManager::new(runtime::controller()))`, add
  commands to `generate_handler!`.
- `.setup` — startup warm-up + **orphan lease recovery**: read lease metadata;
  only terminate a leftover PID when its owner PID is dead AND its command
  marker matches. NEVER blanket-kill `caffeinate` processes.
- `RunEvent::Exit` arm — call `runtime_manager.shutdown()` (same place as the
  existing `WatchRegistry` cleanup).

### 4.6 Auto-mode call sites

- Flow execution start/finish (`commands`/flow runtime) → register/unregister
  `Flow` per cached policy.
- Backend start/stop (`backend`) → register/unregister `Backend`.
- AI / Docker sources reserved (wire when those subsystems expose lifecycle
  hooks).

## 5. Frontend

Current gaps: no Switch/Radio/Checkbox UI primitives, no shared toast system.
Per the "mature solution first, details polished" principle:

- Add reusable `src/components/ui/switch.tsx`, `radio-group.tsx`,
  `checkbox.tsx` (Tailwind + CVA, matching existing `button`/`input`).
- Add a lightweight global toast (`ui/toast.tsx` + a small zustand slice,
  upgrading the existing `ErrorLogDialog` local-toast pattern) for the
  Prevent Sleep enable/disable messages.

New pieces:

- Status-bar Runtime icon + popover panel (new `src/components/runtime/`),
  mounted in the App status bar next to the existing icons.
- Runtime section inside `SettingsDialog.tsx` (radio mode + combinable
  checkboxes).
- `src/lib/runtime-client.ts` (invoke wrappers) + `src/hooks/useRuntime.ts`.
  Settings persisted via `app-persistence.ts` (`getPersistedValue` /
  `setPersistedValue`) → SQLite `app_kv`.
- Backend emits a `RuntimeTransition` Tauri event; frontend shows a toast ONLY
  on the 0↔1 boundary. Icon lit/dim state tracks `prevent_sleep`.

## 6. Error handling & logging

- If Prevent Sleep fails to start: toast `Unable to prevent computer sleep.
  Penguin will continue running normally.` — never crash.
- Log every runtime state change (source, total, transition kind).

## 7. Testing

`runtime/manager.rs` unit tests with a `FakeSleepController` (atomic
engage/release counters):

- 0→1 triggers exactly one `engage`; 1→0 triggers exactly one `release`.
- Concurrent `register_source` across sources does not double-spawn.
- Duplicate / no-owner `unregister` is idempotent and underflow-safe.
- `Manual` + "Ask Every Time" performs only a temporary activation.

## 8. Out of scope (v1)

- Windows / Linux actual implementations (abstraction only).
- Wiring AI / Docker / VPN as live runtime sources (placeholders shown).
- Making the non-Prevent-Sleep status rows interactive.
