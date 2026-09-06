import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("EMBEDDING_LEASE_WATCHDOG_PARENT_PORT_REQUIRED");

interface LeaseWatchdogData {
  dbPath: string;
  betterSqlite3Entry: string;
}

type LeaseWatchdogCommand =
  | {
      type: "begin";
      requestId: number;
      jobIds: string[];
      ownerId: string;
      leaseDurationMs: number;
      heartbeatIntervalMs: number;
    }
  | { type: "end"; requestId: number }
  | { type: "shutdown"; requestId: number };

const config = workerData as LeaseWatchdogData;
const loadDatabase = createRequire(import.meta.url);
type SqliteDatabase = {
  pragma(statement: string): unknown;
  prepare(statement: string): { run(...parameters: unknown[]): { changes: number } };
  transaction<T>(callback: () => T): () => T;
  close(): void;
};
const Database = loadDatabase(config.betterSqlite3Entry) as new (path: string) => SqliteDatabase;
const db = new Database(config.dbPath);

// The watchdog is a second SQLite connection. It must not wait indefinitely
// behind a reader/writer: if renewal cannot reach the ownership boundary, the
// caller must fail closed and let the normal reclaim path retry the jobs.
db.pragma("busy_timeout = 1000");

const renew = db.prepare(`
  UPDATE embedding_jobs
     SET lease_expires_at=?,updated_at=?
   WHERE id=? AND status='running' AND lease_owner=?
     AND lease_expires_at IS NOT NULL AND lease_expires_at>?
`);

let timer: ReturnType<typeof setInterval> | null = null;
let active: {
  jobIds: string[];
  ownerId: string;
  leaseDurationMs: number;
} | null = null;
let stopped = false;

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  active = null;
}

function post(type: string, requestId?: number, code?: string): void {
  parentPort!.postMessage({ type, ...(requestId === undefined ? {} : { requestId }), ...(code ? { code } : {}) });
}

function renewLease(): void {
  if (!active || stopped) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + active.leaseDurationMs).toISOString();
  try {
    const changes = db.transaction(() => {
      const count = active!.jobIds.reduce(
        (total, jobId) => total + renew.run(expiresIso, nowIso, jobId, active!.ownerId, nowIso).changes,
        0,
      );
      if (count !== active!.jobIds.length) throw new Error("EMBEDDING_JOB_OWNERSHIP_LOST");
      return count;
    })();
    if (changes !== active.jobIds.length) throw new Error("EMBEDDING_JOB_OWNERSHIP_LOST");
  } catch (error) {
    stopTimer();
    post(
      "error",
      undefined,
      error instanceof Error && error.message === "EMBEDDING_JOB_OWNERSHIP_LOST"
        ? "EMBEDDING_JOB_OWNERSHIP_LOST"
        : "EMBEDDING_LEASE_WATCHDOG_FAILED",
    );
  }
}

function begin(command: Extract<LeaseWatchdogCommand, { type: "begin" }>): void {
  stopTimer();
  if (command.jobIds.length === 0 || !Number.isInteger(command.leaseDurationMs) || !Number.isInteger(command.heartbeatIntervalMs)) {
    post("error", undefined, "EMBEDDING_LEASE_WATCHDOG_FAILED");
    post("begun", command.requestId);
    return;
  }
  active = {
    jobIds: [...command.jobIds],
    ownerId: command.ownerId,
    leaseDurationMs: command.leaseDurationMs,
  };
  // Renew immediately before acknowledging begin. This closes the startup
  // gap between claiming a job and the first scheduled heartbeat.
  renewLease();
  if (active) timer = setInterval(renewLease, command.heartbeatIntervalMs);
  post("begun", command.requestId);
}

parentPort.on("message", (command: LeaseWatchdogCommand) => {
  if (stopped) return;
  if (command.type === "begin") {
    begin(command);
    return;
  }
  if (command.type === "end") {
    stopTimer();
    post("ended", command.requestId);
    return;
  }
  if (command.type === "shutdown") {
    stopTimer();
    stopped = true;
    try { db.close(); } finally { post("stopped", command.requestId); }
  }
});

post("ready");
