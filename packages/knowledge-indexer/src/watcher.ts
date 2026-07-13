import chokidar, { type FSWatcher } from "chokidar";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { indexRepo, type IndexReport } from "./pipeline.js";

export interface WatcherStatus {
  watching: boolean;
  queued: number;
  runs: number;
  lastIndexedAt: string | null;
  lastError: string | null;
}

export interface WatcherHandle {
  stop(): Promise<void>;
  status(): WatcherStatus;
  // Test seam: resolves after the next debounced index run settles.
  whenIdle(): Promise<void>;
}

// Live incremental indexing: watch the repo, debounce bursts, run an
// incremental indexRepo per settle (§6.3). Started via `penguin watch <path>`
// — the app spawns that as a long-running child process (never waited on,
// killed on toggle-off/app-exit) rather than embedding chokidar in the Rust
// side, so CLI/MCP/app share the exact same indexing code path (§8.3).
// Ignored dirs mirror the walk filter.
export function startWatcher(input: {
  store: KnowledgeStore;
  rootPath: string;
  debounceMs?: number;
  onRun?: (report: IndexReport) => void;
}): WatcherHandle {
  const debounceMs = input.debounceMs ?? 2000;
  const status: WatcherStatus = { watching: false, queued: 0, runs: 0, lastIndexedAt: null, lastError: null };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let idleResolvers: Array<() => void> = [];

  function settleIdle() {
    const r = idleResolvers;
    idleResolvers = [];
    for (const res of r) res();
  }

  async function runOnce(): Promise<void> {
    if (running) {
      // coalesce: a run in flight; schedule one more pass after it
      status.queued = 1;
      return;
    }
    running = true;
    status.queued = 0;
    try {
      const report = await indexRepo({ store: input.store, rootPath: input.rootPath, mode: "incremental" });
      status.runs += 1;
      status.lastIndexedAt = new Date().toISOString();
      input.onRun?.(report);
    } catch (e) {
      status.lastError = (e as Error).message;
    } finally {
      running = false;
      if (status.queued > 0) {
        await runOnce();
      } else {
        settleIdle();
      }
    }
  }

  function schedule() {
    status.queued = 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, debounceMs);
  }

  const watcher: FSWatcher = chokidar.watch(input.rootPath, {
    ignored: (p: string) => /(^|[/\\])(\.git|node_modules|target|dist|build)([/\\]|$)/.test(p),
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on("all", schedule);
  watcher.on("ready", () => {
    status.watching = true;
  });

  return {
    status: () => ({ ...status }),
    whenIdle: () =>
      new Promise<void>((resolve) => {
        if (!running && !timer && status.queued === 0) resolve();
        else idleResolvers.push(resolve);
      }),
    stop: async () => {
      if (timer) clearTimeout(timer);
      status.watching = false;
      await watcher.close();
    },
  };
}
