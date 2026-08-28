import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { ExtractedFile } from "./extract.js";
import { extractSymbols } from "./extract.js";
import type { Lang } from "./registry.js";

// Parallel tree-sitter parsing in front of a single-writer SQLite pipeline.
//
// Indexing is CPU-bound in parse and I/O-serialised in write: a profile of a
// real run attributed most native time to tree-sitter WASM, while the write
// side cannot be parallelised (one SQLite writer). So the parse of file N+1
// runs in a worker while the main thread is still writing file N's rows.
//
// Deliberately NOT a general work queue: the pipeline consumes files in order
// and needs each ExtractedFile before it writes that file, so the pool is a
// read-ahead window. Cheap to reason about, and it degrades to the in-process
// parse whenever workers are unavailable or the batch is too small to pay for
// them.

export interface ParsePoolOptions {
  /** 0 or 1 disables the pool (parse in-process). Default: cores - 1, max 6. */
  size?: number;
  /** Below this many files the pool is not worth its startup cost. */
  minFiles?: number;
}

export interface ParseTask {
  lang: Lang;
  source: string;
  relPath: string;
}

interface Pending {
  resolve: (value: ExtractedFile) => void;
  reject: (error: Error) => void;
}

const WASM_STARTUP_BUDGET_FILES = 24;

export class ParsePool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ task: ParseTask; pending: Pending }> = [];
  private readonly inFlight = new Map<number, { worker: Worker; pending: Pending }>();
  private nextId = 1;
  private closed = false;

  static resolveSize(options: ParsePoolOptions | undefined, fileCount: number): number {
    const configured = Number(process.env.PENGUIN_PARSE_WORKERS ?? options?.size ?? NaN);
    const minFiles = options?.minFiles ?? WASM_STARTUP_BUDGET_FILES;
    // Each worker instantiates its own tree-sitter grammars; on a handful of
    // files that startup costs more than the parsing it saves.
    if (fileCount < minFiles) return 0;
    if (Number.isFinite(configured)) return Math.max(0, Math.min(8, Math.floor(configured)));
    let cores = 4;
    try {
      cores = availableParallelism();
    } catch {
      // older runtimes — the default below is fine
    }
    return Math.max(0, Math.min(6, cores - 1));
  }

  constructor(size: number) {
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(new URL("./parse-worker.js", import.meta.url));
      worker.unref();
      worker.on("message", (message: { type: string; id: number; ok: boolean; extracted?: ExtractedFile; message?: string }) => {
        if (message.type !== "parsed") return;
        const entry = this.inFlight.get(message.id);
        if (!entry) return;
        this.inFlight.delete(message.id);
        this.idle.push(entry.worker);
        if (message.ok && message.extracted) entry.pending.resolve(message.extracted);
        else entry.pending.reject(new Error(message.message ?? "parse worker failed"));
        this.drain();
      });
      worker.on("error", (error) => {
        // Fail the job this worker held and stop using it. The caller falls
        // back to an in-process parse, so a broken worker degrades speed and
        // never correctness.
        for (const [id, entry] of this.inFlight) {
          if (entry.worker !== worker) continue;
          this.inFlight.delete(id);
          entry.pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        const at = this.workers.indexOf(worker);
        if (at >= 0) this.workers.splice(at, 1);
        const idleAt = this.idle.indexOf(worker);
        if (idleAt >= 0) this.idle.splice(idleAt, 1);
        this.drain();
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private drain(): void {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      const id = this.nextId++;
      this.inFlight.set(id, { worker, pending: job.pending });
      worker.postMessage({ type: "parse", id, ...job.task });
    }
  }

  /** Parse via a worker, or in-process when no worker is available. */
  async parse(task: ParseTask): Promise<ExtractedFile> {
    if (this.closed || this.workers.length === 0) {
      return extractSymbols({ lang: task.lang, source: task.source, relPath: task.relPath });
    }
    return new Promise<ExtractedFile>((resolve, reject) => {
      this.queue.push({ task, pending: { resolve, reject } });
      this.drain();
    }).catch(() => extractSymbols({ lang: task.lang, source: task.source, relPath: task.relPath }));
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.workers];
    this.workers.length = 0;
    this.idle.length = 0;
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => -1)));
  }
}
