import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
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

// §2.2 / §9：只接受 checksum 有效且 seq 连续的前缀。
// 任何一行校验失败（JSON 解析 / checksum / seq 断号）即在该行停止，
// 返回之前的完整前缀，并报告截断位置与原因——绝不静默丢弃中间行再继续。
export function readLedgerFile(path: string): LedgerReadResult {
  if (!existsSync(path)) {
    return { events: [], truncatedAtLine: null, truncatedReason: null };
  }
  const events: LedgerEvent[] = [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) break; // 末尾正常换行
    if (!line.trim()) continue;

    let parsed: LedgerEvent;
    try {
      parsed = JSON.parse(line) as LedgerEvent;
    } catch {
      return {
        events,
        truncatedAtLine: i + 1,
        truncatedReason: `line ${i + 1}: JSON parse failed (possible partial write)`,
      };
    }

    const { checksum, ...body } = parsed;
    if (checksum !== eventChecksum(body as Omit<LedgerEvent, "checksum">)) {
      return {
        events,
        truncatedAtLine: i + 1,
        truncatedReason: `line ${i + 1}: checksum mismatch`,
      };
    }

    const expectedSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 1;
    if (parsed.seq !== expectedSeq) {
      return {
        events,
        truncatedAtLine: i + 1,
        truncatedReason: `line ${i + 1}: seq ${parsed.seq}, expected ${expectedSeq}`,
      };
    }

    events.push(parsed);
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

// JSON 归一化：把 payload/target/provenance 先过一遍 JSON.parse(JSON.stringify(...))，
// 使 checksum（canonicalJson）与落盘（JSON.stringify）看到完全一致的值。否则带
// toJSON 的对象（如 Date）会：checksum 按对象自身键算（{}）、磁盘写成 ISO 串，
// 读回必然 checksum 失败并连坐丢失后缀。
function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

// writeSync 可能部分写入——循环直到整段落盘。
function writeAll(fd: number, data: string): void {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

// 崩溃残尾/损坏修复：把文件截断到「有效前缀」（第 truncatedAtLine 行之前），
// 坏尾字节存档到 <path>.corrupt。必须在 append 写入前做，否则新事件会粘在残行
// 同一物理行上、或落在损坏行之后——两种情况下 readLedgerFile 都会在坏行停止，
// 使新写入的不可再生知识在重放/重建时静默蒸发（终审 Critical）。
// 说明：全文件按行校验的成本是 O(n)，但只在检测到损坏时才重写；正常 append
// 只多一次 readLedgerFile（与原先 readLastSeqUnderLock 同为一次全文件读）。
function repairToValidPrefix(path: string, truncatedAtLine: number): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const keep = lines.slice(0, truncatedAtLine - 1);
  const corrupt = lines.slice(truncatedAtLine - 1).join("\n");
  if (corrupt.trim()) {
    try {
      appendFileSync(
        path + ".corrupt",
        `--- repaired ${new Date().toISOString()} (from line ${truncatedAtLine}) ---\n${corrupt}\n`,
      );
    } catch {
      // 存档失败不阻塞修复：账本一致性优先于取证副本
    }
  }
  writeFileSync(path, keep.length > 0 ? keep.join("\n") + "\n" : "");
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
      // 锁内读一次有效前缀：拿 lastSeq，并在检测到坏尾时先修复，保证新事件
      // 落在一个连续有效的账本尾部。
      const read = readLedgerFile(this.path);
      if (read.truncatedAtLine !== null) {
        repairToValidPrefix(this.path, read.truncatedAtLine);
      }
      const lastSeq =
        read.events.length > 0 ? read.events[read.events.length - 1].seq : 0;
      const body: Omit<LedgerEvent, "checksum"> = {
        seq: lastSeq + 1,
        id: `led_${randomUUID()}`,
        ts: now(),
        type: input.type,
        origin: input.origin,
        method: input.method,
        actor: normalizeJson(input.actor),
        target: normalizeJson(input.target ?? {}),
        payload: normalizeJson(input.payload ?? {}),
        provenance: normalizeJson(input.provenance ?? {}),
      };
      const event: LedgerEvent = { ...body, checksum: eventChecksum(body) };
      const fd = openSync(this.path, "a");
      try {
        writeAll(fd, JSON.stringify(event) + "\n");
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
