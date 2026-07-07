import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";

export type LedgerOrigin =
  | "parser"
  | "user"
  | "ai"
  | "import"
  | "system"
  | `plugin:${string}`;
export type LedgerMethod = "EXTRACTED" | "INFERRED" | "ASSERTED";

export interface LedgerTarget {
  node_id?: string | null;
  edge_id?: string | null;
  repo_id?: string | null;
  branch_id?: string | null;
  workspace_id?: string | null;
}

export interface LedgerEventInput {
  type: string;
  origin: LedgerOrigin;
  method: LedgerMethod;
  actor: { type: "user" | "ai" | "system"; id: string };
  target?: LedgerTarget;
  payload?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface LedgerEvent extends LedgerEventInput {
  seq: number;
  id: string;
  ts: string;
  checksum: string;
}

export function eventChecksum(body: Omit<LedgerEvent, "checksum">): string {
  return sha256Hex(canonicalJson(body));
}

export interface LedgerReadResult {
  events: LedgerEvent[];
  truncatedAtLine: number | null;
  truncatedReason: string | null;
}

// Task 4 完整实现校验；本 Task 先提供解析（不校验 checksum/seq），
// 让 Ledger.open 能续算 lastSeq。Task 4 会替换此函数体并保持签名不变。
export function readLedgerFile(path: string): LedgerReadResult {
  if (!existsSync(path)) {
    return { events: [], truncatedAtLine: null, truncatedReason: null };
  }
  const events: LedgerEvent[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as LedgerEvent);
  }
  return { events, truncatedAtLine: null, truncatedReason: null };
}

// 跨进程文件锁（spec §8.3）：app 和 CLI 可能同时追加账本。
// 「读 lastSeq → 写行 → fsync」必须整体在锁内，否则 seq 会分叉。
function acquireLock(lockPath: string, timeoutMs = 5000): void {
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        // 持锁进程崩溃的残留锁：超过 30s 视为死锁残骸，清掉重试
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // 锁文件在检查间隙被释放，直接重试
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`ledger lock timeout: ${lockPath}`);
      }
      const spinUntil = Date.now() + 5;
      while (Date.now() < spinUntil) {
        // 自旋 5ms：append 是毫秒级操作，不值得为它引入异步 API
      }
    }
  }
}

// 锁内快速读末行 seq——其他进程可能刚追加过，任何内存缓存都不可信。
// 末尾残行（写一半崩溃）跳过取上一行，与 readLedgerFile 的截断语义一致。
function readLastSeqUnderLock(path: string): number {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as { seq?: number }).seq;
      if (typeof seq === "number") return seq;
    } catch {
      continue;
    }
  }
  return 0;
}

export class Ledger {
  private constructor(readonly path: string) {}

  static open(path: string): { ledger: Ledger; read: LedgerReadResult } {
    const read = readLedgerFile(path);
    return { ledger: new Ledger(path), read };
  }

  // §2.2：单行完整写入 + fsync，整体持跨进程锁。
  append(
    input: LedgerEventInput,
    now: () => string = () => new Date().toISOString(),
  ): LedgerEvent {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = this.path + ".lock";
    acquireLock(lockPath);
    try {
      const body: Omit<LedgerEvent, "checksum"> = {
        seq: readLastSeqUnderLock(this.path) + 1,
        id: `led_${randomUUID()}`,
        ts: now(),
        type: input.type,
        origin: input.origin,
        method: input.method,
        actor: input.actor,
        target: input.target ?? {},
        payload: input.payload ?? {},
        provenance: input.provenance ?? {},
      };
      const event: LedgerEvent = { ...body, checksum: eventChecksum(body) };
      const fd = openSync(this.path, "a");
      try {
        writeSync(fd, JSON.stringify(event) + "\n", null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return event;
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // 锁已被 stale 清理逻辑移除——无害
      }
    }
  }
}
