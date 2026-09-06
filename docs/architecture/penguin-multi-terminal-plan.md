# 🐧 Penguin Multi Terminal --- Implementation Plan

> 状态：Future / Not Implemented  
> 计划执行：未来版本，当前不进入实施  
> 说明：本文件是架构规划，不代表当前仓库已经具备 Multi Terminal 能力。


## 1. Objective

Add a lightweight **Multi Terminal** module into Penguin so Warp is no
longer required just to keep several terminals open.

Penguin is **not becoming an IDE**. Terminal is an independent tool
beside Client, Vault, REST, Docs and Wiki.

### Scope

**V1** - Real macOS shell, defaulting to the user's `$SHELL` / zsh -
Multiple independent terminals - Tabs: create, switch, rename and
close - Different working directory per terminal - Sessions keep running
when navigating to REST/Vault/etc. - Resize, scrollback, ANSI colors,
copy/paste - Normal shell keyboard behavior including Ctrl+C - Clean
process shutdown

**V2, only after V1 is stable** - Split Right / Split Down - Nested
panes and draggable resizing - Search terminal output

**Do not build** - AI or Agents - Workflows - File explorer - Code
editor / IDE - Command blocks - Cloud/collaboration - Custom shell,
history database or autocomplete engine

------------------------------------------------------------------------

## 2. Architecture

``` text
React / Penguin UI
        │
        ▼
     xterm.js
        │  input / output / resize
        ▼
 Tauri IPC / Channel
        │
        ▼
Rust TerminalManager
        │
        ▼
   portable-pty
        │
        ▼
  zsh / bash / fish
```

`xterm.js` is the terminal display. `portable-pty` owns the real PTY and
shell. Tauri connects both sides.

### Critical lifecycle rule

React page lifecycle must NOT control the shell lifecycle.

``` text
Open Terminal → PTY starts → run pnpm dev
                         ↓
                 navigate to REST
                         ↓
                   PTY still runs
                         ↓
                return to Terminal
```

A PTY ends only when the user closes that terminal or Penguin exits.

------------------------------------------------------------------------

## 3. Rust Backend

Recommended structure:

``` text
src-tauri/src/terminal/
├── mod.rs
├── manager.rs
├── session.rs
├── commands.rs
├── events.rs
└── types.rs
```

### TerminalManager

One app-level manager owns all active sessions.

``` text
TerminalManager
└── sessions
    ├── terminal-1 → TerminalSession
    ├── terminal-2 → TerminalSession
    └── terminal-3 → TerminalSession
```

Responsibilities: create, list, lookup, write, resize, kill and clean up
sessions.

Rust is the source of truth for whether a terminal process exists.

### TerminalSession

Each session contains conceptually:

``` text
id
name
cwd
shell
PTY master/writer
output reader
child process
```

One session = one PTY = one shell.

------------------------------------------------------------------------

## 4. Minimal Tauri API

Keep the API narrow:

### `terminal_create`

Input: optional `cwd`, optional `shell`.\
Output: `terminalId`.

Shell fallback: 1. requested shell 2. `$SHELL` 3. `/bin/zsh`

### `terminal_write`

Input: `terminalId`, `data`.

``` text
xterm.onData → Tauri → PTY writer → shell
```

### `terminal_resize`

Input: `terminalId`, `cols`, `rows`.

Required so interactive apps such as `top`, `vim`, `less` and `git log`
render correctly.

### `terminal_kill`

Terminate child, stop reader, remove session and release PTY resources.

### `terminal_list`

Return active Rust-owned sessions so UI state can be reconstructed.

### Output

Do not poll. Push output:

``` text
PTY reader → buffered chunks → Tauri Channel/Event → xterm.write()
```

Avoid one IPC call per byte.

------------------------------------------------------------------------

## 5. Frontend

Recommended structure:

``` text
src/features/terminal/
├── components/
│   ├── TerminalPage.tsx
│   ├── TerminalTabs.tsx
│   ├── TerminalView.tsx
│   └── NewTerminalButton.tsx
├── hooks/
│   ├── useTerminal.ts
│   └── useTerminalResize.ts
├── services/terminal.service.ts
├── store/terminal.store.ts
└── types/terminal.types.ts
```

Frontend state contains only UI metadata such as `activeTerminalId` and
terminal names. Do not store all terminal output in React state.

xterm lifecycle:

``` text
create Terminal
→ load FitAddon
→ open container
→ fit
→ listen onData
→ forward input to Rust
```

Output direction:

``` text
zsh → PTY → Rust → Tauri → xterm.write()
```

------------------------------------------------------------------------

## 6. V1 UI

Keep it consistent with Penguin:

``` text
┌──────────────────────────────────────────────────────────┐
│ Terminal 1   API Server   Redis                    ＋    │
├──────────────────────────────────────────────────────────┤
│ ~/fpms-nt                                                │
│ ❯ pnpm start:dev                                         │
│                                                          │
│ Server running on :3000                                  │
│ █                                                        │
└──────────────────────────────────────────────────────────┘
```

Tab menu only needs Rename and Close initially.

Add `>_ Terminal` as another first-class item in Penguin's existing left
navigation. Do not introduce IDE-style Explorer/Source Control/Debug
panels.

Suggested shortcuts:

``` text
Cmd+T           New terminal
Cmd+W           Close current terminal
Cmd+Shift+]     Next terminal
Cmd+Shift+[     Previous terminal
Cmd+K           Clear terminal
Cmd+F           Search output (V2)
```

Shortcuts must be context-aware and must not unnecessarily override
existing Penguin shortcuts.

------------------------------------------------------------------------

## 7. Working Directory & Shell Environment

New terminal cwd fallback:

1.  explicitly requested cwd
2.  configured Penguin workspace directory, if appropriate
3.  `$HOME`

The terminal should behave like the user's normal terminal.

Explicitly test:

``` bash
git status
node --version
pnpm --version
cargo --version
docker ps
kubectl get pods
redis-cli
psql
```

macOS GUI apps may receive a different PATH/environment than
Terminal.app. Verify Homebrew, `.zshrc`, rustup/cargo, Node version
manager, pnpm, Docker CLI and kubectl.

------------------------------------------------------------------------

## 8. Memory & Performance Rules

Low RAM is a primary goal.

-   Start no PTY until requested
-   No AI/background services/indexing/cloud sync
-   Keep scrollback bounded; start around 5,000--10,000 lines
-   Do not duplicate terminal output into React state
-   Stream output rather than accumulating it forever
-   Clean dead PTYs immediately
-   Avoid unnecessary hidden terminal renderers
-   Idle terminals should consume effectively no meaningful CPU

For V1, keeping xterm instances alive but hidden between tabs is
acceptable if simplest. Benchmark before building a complicated
detach/restore mechanism.

Test high-output commands such as `docker logs -f`, `cargo build`,
`npm install` and `yes`. Large output must not freeze Penguin.

------------------------------------------------------------------------

## 9. Cleanup & Error Handling

Closing one tab must kill only its owned shell/process. Closing Penguin
must clean all managed sessions so accidental orphan `zsh`, `node`,
`cargo`, `tail`, etc. processes are not left behind.

Handle: - PTY creation failure - missing shell - invalid cwd -
write/resize failure - child exit - unknown/closed terminal ID - reader
disconnect

One failed terminal must never crash Penguin.

Suggested states: `starting`, `running`, `exited`, `failed`.

------------------------------------------------------------------------

## 10. V2 Split Design

Only implement after tabs are reliable.

Represent splits as a layout tree:

``` text
        horizontal
        /        \
   terminal-1   vertical
                /      \
         terminal-2  terminal-3
```

This renders naturally as:

``` text
┌────────────────────┬────────────────────┐
│                    │ Terminal 2         │
│ Terminal 1         ├────────────────────┤
│                    │ Terminal 3         │
└────────────────────┴────────────────────┘
```

Use `SplitNode(direction, children, sizes)` and
`TerminalNode(terminalId)` so nested splits do not require a redesign
later.

------------------------------------------------------------------------

## 11. Implementation Roadmap

### Phase 0 --- Technical Spike

Build exactly one xterm + one PTY + zsh.

Acceptance: `pwd`, `ls`, `git status`, Node/Cargo commands, ANSI colors,
Ctrl+C, resizing and interactive CLI programs work.

### Phase 1 --- Reliable Single Terminal

Implement TerminalManager, create/write/output/resize/kill, cleanup,
errors, FitAddon and correct shell environment.

### Phase 2 --- Multi Terminal Tabs

Add create/switch/rename/close and independent cwd/PTYs.

Daily test:

``` text
Terminal 1 → pnpm dev
Terminal 2 → cargo run
Terminal 3 → docker logs -f service
Terminal 4 → normal shell
```

Switching tabs must not interrupt any process.

### Phase 3 --- Penguin Integration

Add Terminal to navigation. Verify `Terminal → REST → Vault → Terminal`
does not restart sessions. Match Penguin's existing visual language.

### Phase 4 --- Keyboard UX

Add tab creation/closing/navigation, copy/paste and clear shortcuts.
Resolve conflicts with Penguin global shortcuts.

### Phase 5 --- Performance Pass

Benchmark: - Penguin baseline - +1 idle terminal - +5 idle terminals -
+10 idle terminals - +5 active terminals

Measure RAM, idle CPU, heavy-output CPU, responsiveness and output
latency. Compare with the same workload in Warp.

Goal: **Penguin + Multi Terminal should have clearly less overhead than
keeping Penguin + Warp open together.**

### Phase 6 --- Split Terminal

Only after V1 has been used successfully in daily work. Add split
right/down, nested layouts, resize, pane close/focus and keyboard pane
navigation.

------------------------------------------------------------------------

## 12. Testing Checklist

-   [ ] zsh starts and prompt/colors/Unicode render correctly
-   [ ] shell history, Ctrl+C/D, arrows and tab completion work
-   [ ] git, cargo, node/pnpm, docker and kubectl work
-   [ ] interactive programs resize correctly
-   [ ] create 10 independent terminals
-   [ ] switching tabs never interrupts background processes
-   [ ] closing one tab kills only that terminal
-   [ ] different cwd per terminal works
-   [ ] navigating away from Terminal keeps sessions alive
-   [ ] Mac sleep/wake does not corrupt sessions
-   [ ] closing Penguin cleans owned terminal processes
-   [ ] idle terminals do not burn CPU
-   [ ] large output does not freeze the UI
-   [ ] repeated create/close does not continuously grow memory

------------------------------------------------------------------------

## 13. V1 Definition of Done

This workflow must be reliable:

``` text
Open Penguin
→ Terminal
→ create "API" and run pnpm start:dev
→ create "Logs" and run docker logs -f service
→ create "Work" for normal git/cargo commands
→ switch to REST/Vault
→ return later
→ all terminals are still alive
```

Closing `Logs` kills only that session. Closing Penguin cleans up its
terminal sessions.

------------------------------------------------------------------------

## 14. Final Rule

Do not prematurely optimize or expand scope into Warp/IDE features.

The target is:

> **A small, fast, reliable multi-terminal inside Penguin --- not Warp
> inside Penguin.**

Recommended V1 architecture:

``` text
Penguin
└── Terminal UI (React + xterm.js)
       │
       ▼
   Tauri IPC/Channel
       │
       ▼
   Rust TerminalManager
       ├── Session 1 → PTY → zsh
       ├── Session 2 → PTY → zsh
       └── Session 3 → PTY → zsh
```
