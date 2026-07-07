# Penguin Knowledge Core (Plan 1/5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `packages/knowledge-core`——Penguin Knowledge 的存储核心：Ledger（append-only JSONL 账本）+ SQLite Index（全量 schema）+ KnowledgeStore（写路径收口），实现 spec §2.1/§2.2 的 Ledger/Index 双层铁律。

**Architecture:** 纯 TypeScript Node 包，零 UI。`ledger.jsonl` 是不可再生知识的真相源（每行 seq + checksum）；`knowledge.db`（better-sqlite3, WAL）是可删除重建的物化索引；`KnowledgeStore` 是唯一对外 API——不可再生知识只能走 `recordKnowledge()`（先账本后物化），解析衍生数据走直写方法（带 origin 断言防护）。

**Tech Stack:** TypeScript 5.7 (NodeNext ESM) · better-sqlite3 · node:crypto · node:test

**Spec:** `requirements/knowledge-design.md` v2.2（本计划实现 §2.1、§2.2、§3 全部表 + §9 的 Ledger 相关恢复行为 + §10 的 Ledger/存储测试）

## Global Constraints

- 包名 `@penguin/knowledge-core`，目录 `packages/knowledge-core/`，镜像 `packages/core` 约定：`"type": "module"`、tsc 构建到 `dist/`、`main`/`types`/`exports` 三件套
- TS 编译目标：`target ES2022`、`module NodeNext`、`moduleResolution NodeNext`、`strict true`——**包内 import 一律带 `.js` 后缀**（Node ESM 运行时要求）
- 测试：node:test 运行器，文件放根目录 `tests/knowledge-core-*.test.mjs`，import 构建产物 `../packages/knowledge-core/dist/index.js`——**每次跑测试前先 `pnpm -F @penguin/knowledge-core build`**
- §2.2 铁律：不可再生知识唯一写入口 `recordKnowledge()`（appendLedger → materialize，顺序不可颠倒）；`replaceFileEdges()` 断言每条边 `origin === "parser"`，否则抛错
- 物化行的 id 必须从账本事件 id 确定性派生（`edge_<eventId>`、`alias_<eventId>`），保证重建可复现
- canonical JSON：键按字典序、丢弃 undefined；checksum = sha256(排除 checksum 字段的 canonical JSON)
- 核心关系模型不用 SQLite 专有特性（D4）；FTS5 只出现在 `fts_*` 虚表和 `searchText()` 内部
- 新原生依赖只允许 better-sqlite3，必须同步加进根 package.json 的 `pnpm.onlyBuiltDependencies`
- 提交信息末尾带：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 包脚手架 + 根工程接线

**Files:**
- Create: `packages/knowledge-core/package.json`
- Create: `packages/knowledge-core/tsconfig.json`
- Create: `packages/knowledge-core/src/index.ts`
- Modify: `package.json`（根：build/typecheck 脚本 + onlyBuiltDependencies）
- Test: `tests/knowledge-core-scaffold.test.mjs`

**Interfaces:**
- Produces: `@penguin/knowledge-core` 可构建、可从 dist import；后续所有 Task 的模块都从 `src/` 新增并经 `src/index.ts` re-export

- [ ] **Step 1: 创建包文件**

`packages/knowledge-core/package.json`：

```json
{
  "name": "@penguin/knowledge-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch"
  },
  "dependencies": {
    "better-sqlite3": "^12.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0"
  }
}
```

`packages/knowledge-core/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

`packages/knowledge-core/src/index.ts`：

```typescript
export const KNOWLEDGE_CORE_VERSION = "0.0.1";
```

- [ ] **Step 2: 根 package.json 接线**

修改根 `package.json`：

1. `scripts.build` 改为：`"pnpm -F @penguin/core build && pnpm -F @penguin/mcp build && pnpm -F @penguin/knowledge-core build && tsc -b && vite build"`
2. `scripts.typecheck` 改为：`"pnpm -F @penguin/core build && pnpm -F @penguin/mcp build && pnpm -F @penguin/knowledge-core build && tsc -b"`
3. `pnpm.onlyBuiltDependencies` 改为：`["esbuild", "protobufjs", "better-sqlite3"]`

- [ ] **Step 3: 安装依赖并构建**

Run: `pnpm install && pnpm -F @penguin/knowledge-core build`
Expected: 无报错，生成 `packages/knowledge-core/dist/index.js` 与 `.d.ts`

- [ ] **Step 4: 写冒烟测试**

`tests/knowledge-core-scaffold.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { test } from "node:test";

test("knowledge-core dist is importable", async () => {
  const mod = await import("../packages/knowledge-core/dist/index.js");
  assert.equal(mod.KNOWLEDGE_CORE_VERSION, "0.0.1");
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/knowledge-core-scaffold.test.mjs`
Expected: `pass 1`

- [ ] **Step 6: Commit**

```bash
git add packages/knowledge-core package.json pnpm-lock.yaml tests/knowledge-core-scaffold.test.mjs
git commit -m "feat(knowledge): scaffold @penguin/knowledge-core package"
```

---

### Task 2: canonical JSON + sha256

**Files:**
- Create: `packages/knowledge-core/src/canonical.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-canonical.test.mjs`

**Interfaces:**
- Produces:
  - `canonicalJson(value: unknown): string` — 键字典序、丢弃 undefined 属性、数组保序
  - `sha256Hex(input: string): string` — 十六进制小写

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-canonical.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, sha256Hex } from "../packages/knowledge-core/dist/index.js";

test("canonicalJson sorts object keys recursively", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
  const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
});

test("canonicalJson drops undefined properties, keeps null", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("canonicalJson handles primitives and unicode", () => {
  assert.equal(canonicalJson("中文"), JSON.stringify("中文"));
  assert.equal(canonicalJson(1.5), "1.5");
  assert.equal(canonicalJson(true), "true");
});

test("sha256Hex is stable", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-canonical.test.mjs`
Expected: FAIL —— `canonicalJson` 未导出（SyntaxError: The requested module does not provide an export）

- [ ] **Step 3: 实现**

`packages/knowledge-core/src/canonical.ts`：

```typescript
import { createHash } from "node:crypto";

// 稳定序列化：对象键按字典序、丢弃 undefined 属性、数组保序。
// checksum（§2.2.2）建立在这个规范形之上，两次序列化必须逐字节一致。
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
```

`packages/knowledge-core/src/index.ts` 追加：

```typescript
export { canonicalJson, sha256Hex } from "./canonical.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-canonical.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-canonical.test.mjs
git commit -m "feat(knowledge): canonical JSON serialization + sha256"
```

---

### Task 3: Ledger 追加（append-only + checksum + fsync）

**Files:**
- Create: `packages/knowledge-core/src/ledger.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-ledger.test.mjs`

**Interfaces:**
- Consumes: `canonicalJson`, `sha256Hex`（Task 2）
- Produces:
  - 类型：`LedgerOrigin`（`"parser"|"user"|"ai"|"import"|"system"|` plugin:xxx 模板串）、`LedgerMethod`（`"EXTRACTED"|"INFERRED"|"ASSERTED"`）、`LedgerTarget`、`LedgerEventInput`、`LedgerEvent`
  - `eventChecksum(body: Omit<LedgerEvent, "checksum">): string`
  - `class Ledger`：`Ledger.open(path)` → `{ ledger, read }`；`ledger.append(input, now?)` → `LedgerEvent`（seq 自增、id=`led_<uuid>`、单行写入 + fsync；**整体持跨进程文件锁**——app 与 CLI 同机并发追加不分叉，spec §8.3）
  - Task 4 实现 `readLedgerFile`；本 Task 先给 `Ledger.open` 一个只算 lastSeq 的最小实现

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-ledger.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  eventChecksum,
} from "../packages/knowledge-core/dist/index.js";

function tempLedgerPath() {
  return join(mkdtempSync(join(tmpdir(), "pk-ledger-")), "ledger.jsonl");
}

const INPUT = {
  type: "manual_edge_created",
  origin: "user",
  method: "ASSERTED",
  actor: { type: "user", id: "shieng" },
  target: { node_id: "node_a" },
  payload: { dst: "node_b", edge_type: "wikilink" },
  provenance: { file: "cases/demo.md" },
};

test("append assigns monotonic seq starting at 1 and writes one JSON line each", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  const e1 = ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const e2 = ledger.append(INPUT, () => "2026-07-07T10:00:01.000Z");
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.match(e1.id, /^led_/);

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.seq, 1);
  assert.equal(parsed.origin, "user");
  assert.equal(parsed.method, "ASSERTED");
});

test("checksum covers canonical body excluding checksum itself", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  const e = ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const { checksum, ...body } = e;
  assert.equal(checksum, eventChecksum(body));
});

test("re-open continues seq from existing file", () => {
  const path = tempLedgerPath();
  const first = Ledger.open(path);
  first.ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const second = Ledger.open(path);
  const e = second.ledger.append(INPUT, () => "2026-07-07T10:00:02.000Z");
  assert.equal(e.seq, 2);
});

test("two Ledger instances on the same file never collide on seq", () => {
  const path = tempLedgerPath();
  const a = Ledger.open(path).ledger;
  const b = Ledger.open(path).ledger; // 模拟第二个进程（app vs CLI）
  const e1 = a.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const e2 = b.append(INPUT, () => "2026-07-07T10:00:01.000Z");
  const e3 = a.append(INPUT, () => "2026-07-07T10:00:02.000Z");
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-ledger.test.mjs`
Expected: FAIL —— `Ledger` 未导出

- [ ] **Step 3: 实现**

`packages/knowledge-core/src/ledger.ts`：

```typescript
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
```

`packages/knowledge-core/src/index.ts` 追加：

```typescript
export {
  Ledger,
  eventChecksum,
  readLedgerFile,
  type LedgerEvent,
  type LedgerEventInput,
  type LedgerMethod,
  type LedgerOrigin,
  type LedgerReadResult,
  type LedgerTarget,
} from "./ledger.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-ledger.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-ledger.test.mjs
git commit -m "feat(knowledge): ledger append-only writer with checksum, fsync + cross-process lock"
```

---

### Task 4: Ledger 读取校验（checksum、seq 连续性、残行恢复）

**Files:**
- Modify: `packages/knowledge-core/src/ledger.ts`（替换 `readLedgerFile` 函数体）
- Test: `tests/knowledge-core-ledger.test.mjs`（追加用例）

**Interfaces:**
- Produces: `readLedgerFile(path): LedgerReadResult` 完整校验版——checksum 不符 / seq 断号 / JSON 解析失败，都在该行停止：返回之前的完整前缀 + `truncatedAtLine`（1-based）+ `truncatedReason`

- [ ] **Step 1: 追加失败测试**

在 `tests/knowledge-core-ledger.test.mjs` 追加：

```javascript
import { appendFileSync, writeFileSync } from "node:fs";
import { readLedgerFile } from "../packages/knowledge-core/dist/index.js";

test("readLedgerFile validates checksums and stops at tampered line", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const e2 = ledger.append(INPUT, () => "2026-07-07T10:00:01.000Z");
  ledger.append(INPUT, () => "2026-07-07T10:00:02.000Z");

  // 篡改第 2 行 payload 但保留旧 checksum
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.payload.dst = "node_evil";
  lines[1] = JSON.stringify(tampered);
  writeFileSync(path, lines.join("\n") + "\n");

  const result = readLedgerFile(path);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncatedAtLine, 2);
  assert.match(result.truncatedReason, /checksum/i);
  void e2;
});

test("readLedgerFile stops at seq gap", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const orphan = Ledger.open(tempLedgerPath());
  orphan.ledger.append(INPUT, () => "2026-07-07T10:00:01.000Z"); // seq=1
  const orphanLine = readFileSync(orphan.ledger.path, "utf8");
  appendFileSync(path, orphanLine); // 追加 seq=1 到已有 seq=1 之后 → 断号

  const result = readLedgerFile(path);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncatedAtLine, 2);
  assert.match(result.truncatedReason, /seq/i);
});

test("readLedgerFile ignores partial final line and reports it", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  appendFileSync(path, '{"seq":2,"id":"led_x","ts":"2026-07-0'); // 模拟写一半崩溃

  const result = readLedgerFile(path);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncatedAtLine, 2);
  assert.match(result.truncatedReason, /parse/i);
});

test("append after truncated tail continues from last valid seq", () => {
  const path = tempLedgerPath();
  const first = Ledger.open(path);
  first.ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  appendFileSync(path, "not-json\n");
  const second = Ledger.open(path);
  const e = second.ledger.append(INPUT, () => "2026-07-07T10:00:03.000Z");
  assert.equal(e.seq, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-ledger.test.mjs`
Expected: FAIL —— 篡改行未被检出（Task 3 的占位实现不校验）

- [ ] **Step 3: 替换 readLedgerFile 实现**

`packages/knowledge-core/src/ledger.ts` 中替换整个 `readLedgerFile`：

```typescript
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-ledger.test.mjs`
Expected: `pass 8`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-ledger.test.mjs
git commit -m "feat(knowledge): ledger read validation — checksum, seq continuity, partial-line recovery"
```

---

### Task 5: SQLite schema（全量表 + FTS + WAL）

**Files:**
- Create: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-schema.test.mjs`

**Interfaces:**
- Produces:
  - `openDatabase(path: string): Database`（better-sqlite3 实例；WAL、busy_timeout=5000、foreign_keys=ON、幂等建表、`ledger_state` 预置 `('main', 0)` 行）
  - 表：`repos` `branches` `nodes` `node_aliases` `symbol_versions` `edges` `events` `ledger_state` `workspaces` `workspace_repos` `notes_index` `entities` `meta` + 虚表 `fts_notes` `fts_symbols`
  - 列定义与 spec §3.2 逐字段一致（events 含 `ledger_seq`/`workspace_id`/`origin`/`method`；node_aliases 含 `current_identity_key`）

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-schema.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../packages/knowledge-core/dist/index.js";

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "pk-db-")), "knowledge.db");
}

const EXPECTED_TABLES = [
  "repos", "branches", "nodes", "node_aliases", "symbol_versions",
  "edges", "events", "ledger_state", "workspaces", "workspace_repos",
  "notes_index", "entities", "meta",
];

test("openDatabase creates all tables and FTS virtual tables", () => {
  const db = openDatabase(tempDbPath());
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  assert.ok(names.includes("fts_notes"), "missing fts_notes");
  assert.ok(names.includes("fts_symbols"), "missing fts_symbols");
  db.close();
});

test("openDatabase is idempotent and seeds ledger_state", () => {
  const path = tempDbPath();
  openDatabase(path).close();
  const db = openDatabase(path);
  const row = db.prepare("SELECT * FROM ledger_state WHERE id = 'main'").get();
  assert.equal(row.materialized_seq, 0);
  db.close();
});

test("openDatabase enables WAL", () => {
  const db = openDatabase(tempDbPath());
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
});

test("events table has origin, method, ledger_seq, workspace_id columns", () => {
  const db = openDatabase(tempDbPath());
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  for (const c of ["origin", "method", "ledger_seq", "workspace_id"]) {
    assert.ok(cols.includes(c), `events missing column: ${c}`);
  }
  db.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-schema.test.mjs`
Expected: FAIL —— `openDatabase` 未导出

- [ ] **Step 3: 实现 schema**

`packages/knowledge-core/src/schema.ts`：

```typescript
import Database from "better-sqlite3";

// spec §3.2 全量表。核心关系模型不用 SQLite 专有特性（D4）；
// FTS5 虚表是可随时 drop 重建的加速索引，不属于核心模型。
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head_commit TEXT,
  last_indexed_commit TEXT,
  last_indexed_at TEXT,
  checkout_path TEXT,
  status TEXT NOT NULL,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  repo_id TEXT,
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (node_type, identity_key)
);

CREATE TABLE IF NOT EXISTS node_aliases (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  alias_key TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  current_identity_key TEXT,
  valid_from TEXT,
  valid_to TEXT,
  reason TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, alias_key, alias_type)
);

CREATE TABLE IF NOT EXISTS symbol_versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  UNIQUE (node_id, branch_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL REFERENCES nodes(id),
  dst TEXT REFERENCES nodes(id),
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  origin TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ledger_seq INTEGER,
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id),
  edge_id TEXT REFERENCES edges(id),
  branch_id TEXT REFERENCES branches(id),
  repo_id TEXT REFERENCES repos(id),
  workspace_id TEXT REFERENCES workspaces(id),
  origin TEXT NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS ledger_state (
  id TEXT PRIMARY KEY,
  materialized_seq INTEGER NOT NULL DEFAULT 0,
  materialized_at TEXT,
  ledger_checksum TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  PRIMARY KEY (workspace_id, repo_id)
);

CREATE TABLE IF NOT EXISTS notes_index (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  path TEXT NOT NULL UNIQUE,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  sensitive INTEGER NOT NULL DEFAULT 0,
  ai_access TEXT NOT NULL DEFAULT 'allowed',
  mcp_access TEXT NOT NULL DEFAULT 'allowed',
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  UNIQUE (entity_type, normalized_value)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
  node_id UNINDEXED, title, body
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
  node_id UNINDEXED, name, signature
);
`;

export const SCHEMA_VERSION = 1;

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // 有意不开 foreign_keys：删库后 Ledger 先重放（§2.1 三源重建），
  // 此时被引用的 nodes 尚未由上层索引器重建——引用完整性由
  // 「账本 + 全量重建流程」保证，不靠 SQLite 外键（D4）。
  db.exec(DDL);
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(SCHEMA_VERSION));
  db.prepare(
    "INSERT OR IGNORE INTO ledger_state (id, materialized_seq) VALUES ('main', 0)",
  ).run();
  return db;
}
```

`packages/knowledge-core/src/index.ts` 追加：

```typescript
export { SCHEMA_VERSION, openDatabase } from "./schema.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-schema.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-schema.test.mjs
git commit -m "feat(knowledge): full SQLite schema — nodes/versions/edges/events/ledger_state/FTS"
```

---

### Task 6: Materializer（Ledger → SQLite 物化）

**Files:**
- Create: `packages/knowledge-core/src/materializer.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-materializer.test.mjs`

**Interfaces:**
- Consumes: `LedgerEvent`（Task 3）、`openDatabase` 的表（Task 5）
- Produces:
  - `materialize(db: Database, events: LedgerEvent[]): { applied: number }` —— 只应用 `seq > ledger_state.materialized_seq` 的事件；单事务；每个事件先插 `events` 行（含 origin/method/ledger_seq），再按 type 应用副作用；最后推进 `ledger_state`
  - 物化行 id 确定性派生：alias 行 id=`alias_<eventId>`、edge 行 id=`edge_<eventId>`
  - 事件类型处理（V1）：`node_alias_added`→ upsert `node_aliases`（含 `current_identity_key` 从 nodes 查出）；`manual_edge_created`→ insert `edges`；`alias_merge_undone`→ 对应 alias 行 `valid_to`=事件 ts；其余类型（`ai_suggestion_accepted`、`snapshot_manifest_created` 等）只落 `events` 行

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-materializer.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  materialize,
  openDatabase,
} from "../packages/knowledge-core/dist/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pk-mat-"));
}

function setup() {
  const dir = tempDir();
  const db = openDatabase(join(dir, "knowledge.db"));
  const { ledger } = Ledger.open(join(dir, "ledger.jsonl"));
  db.prepare(
    "INSERT INTO nodes (id, node_type, identity_key, title, created_at) VALUES ('node_a','symbol','repo:UserService.login','UserService.login','2026-07-07T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO nodes (id, node_type, identity_key, title, created_at) VALUES ('node_b','note','cases/demo.md','Demo Case','2026-07-07T00:00:00Z')",
  ).run();
  return { db, ledger };
}

const ALIAS_EVENT = {
  type: "node_alias_added",
  origin: "system",
  method: "EXTRACTED",
  actor: { type: "system", id: "knowledge-indexer" },
  target: { node_id: "node_a" },
  payload: {
    alias_key: "repo:UserService.signIn",
    alias_type: "qualified_name",
    reason: "rename",
    confidence: 1.0,
  },
  provenance: { file: "src/auth/user.service.ts", commit: "abc123" },
};

const EDGE_EVENT = {
  type: "manual_edge_created",
  origin: "user",
  method: "ASSERTED",
  actor: { type: "user", id: "shieng" },
  target: { node_id: "node_b" },
  payload: { src: "node_b", dst: "node_a", edge_type: "wikilink" },
  provenance: {},
};

test("materialize applies alias + edge events and advances ledger_state", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  const e2 = ledger.append(EDGE_EVENT, () => "2026-07-07T10:00:01.000Z");

  const { applied } = materialize(db, [e1, e2]);
  assert.equal(applied, 2);

  const alias = db
    .prepare("SELECT * FROM node_aliases WHERE node_id = 'node_a'")
    .get();
  assert.equal(alias.alias_key, "repo:UserService.signIn");
  assert.equal(alias.current_identity_key, "repo:UserService.login");
  assert.equal(alias.id, `alias_${e1.id}`);

  const edge = db.prepare("SELECT * FROM edges WHERE src = 'node_b'").get();
  assert.equal(edge.dst, "node_a");
  assert.equal(edge.origin, "user");
  assert.equal(edge.method, "ASSERTED");
  assert.equal(edge.id, `edge_${e2.id}`);

  const evRows = db.prepare("SELECT * FROM events ORDER BY ledger_seq").all();
  assert.equal(evRows.length, 2);
  assert.equal(evRows[0].origin, "system");
  assert.equal(evRows[0].method, "EXTRACTED");

  const state = db.prepare("SELECT * FROM ledger_state WHERE id='main'").get();
  assert.equal(state.materialized_seq, 2);
  db.close();
});

test("materialize is resumable — already-applied events are skipped", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  materialize(db, [e1]);
  const e2 = ledger.append(EDGE_EVENT, () => "2026-07-07T10:00:01.000Z");

  const { applied } = materialize(db, [e1, e2]); // 全量传入，只应 1 条
  assert.equal(applied, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    2,
  );
  db.close();
});

test("alias_merge_undone sets valid_to on the alias", () => {
  const { db, ledger } = setup();
  const e1 = ledger.append(ALIAS_EVENT, () => "2026-07-07T10:00:00.000Z");
  const undo = ledger.append(
    {
      type: "alias_merge_undone",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: "shieng" },
      target: { node_id: "node_a" },
      payload: {
        alias_key: "repo:UserService.signIn",
        alias_type: "qualified_name",
      },
      provenance: {},
    },
    () => "2026-07-07T11:00:00.000Z",
  );
  materialize(db, [e1, undo]);
  const alias = db
    .prepare("SELECT * FROM node_aliases WHERE node_id='node_a'")
    .get();
  assert.equal(alias.valid_to, "2026-07-07T11:00:00.000Z");
  db.close();
});

test("unknown event types land in events table only", () => {
  const { db, ledger } = setup();
  const e = ledger.append(
    {
      type: "snapshot_manifest_created",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: "shieng" },
      payload: { name: "incident-42" },
      provenance: {},
    },
    () => "2026-07-07T10:00:00.000Z",
  );
  const { applied } = materialize(db, [e]);
  assert.equal(applied, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  db.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-materializer.test.mjs`
Expected: FAIL —— `materialize` 未导出

- [ ] **Step 3: 实现**

`packages/knowledge-core/src/materializer.ts`：

```typescript
import type DatabaseCtor from "better-sqlite3";
import type { LedgerEvent } from "./ledger.js";

type Database = DatabaseCtor.Database;

// Ledger → SQLite 物化（§2.1/§2.2）。
// events/node_aliases/manual edges 是账本的物化视图——本模块是唯一写它们的地方。
// 物化行 id 从账本事件 id 确定性派生，保证「删库重放」结果逐字节可复现。
export function materialize(
  db: Database,
  events: LedgerEvent[],
): { applied: number } {
  const state = db
    .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
    .get() as { materialized_seq: number };
  const pending = events
    .filter((e) => e.seq > state.materialized_seq)
    .sort((a, b) => a.seq - b.seq);
  if (pending.length === 0) return { applied: 0 };

  const insertEvent = db.prepare(`
    INSERT INTO events (id, ledger_seq, ts, event_type, node_id, edge_id,
      branch_id, repo_id, workspace_id, origin, method, payload, provenance)
    VALUES (@id, @ledger_seq, @ts, @event_type, @node_id, @edge_id,
      @branch_id, @repo_id, @workspace_id, @origin, @method, @payload, @provenance)
  `);
  const upsertAlias = db.prepare(`
    INSERT INTO node_aliases (id, node_id, alias_key, alias_type,
      current_identity_key, valid_from, reason, confidence, created_at)
    VALUES (@id, @node_id, @alias_key, @alias_type,
      @current_identity_key, @valid_from, @reason, @confidence, @created_at)
    ON CONFLICT (node_id, alias_key, alias_type) DO UPDATE SET
      valid_to = NULL, reason = @reason, confidence = @confidence
  `);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (id, src, dst, raw_target, edge_type,
      branch_id, origin, method, confidence, provenance)
    VALUES (@id, @src, @dst, @raw_target, @edge_type,
      @branch_id, @origin, @method, @confidence, @provenance)
  `);
  const undoAlias = db.prepare(`
    UPDATE node_aliases SET valid_to = @valid_to
    WHERE node_id = @node_id AND alias_key = @alias_key AND alias_type = @alias_type
  `);
  const lookupIdentity = db.prepare(
    "SELECT identity_key FROM nodes WHERE id = ?",
  );
  const advance = db.prepare(
    "UPDATE ledger_state SET materialized_seq = ?, materialized_at = ? WHERE id = 'main'",
  );

  const run = db.transaction((batch: LedgerEvent[]) => {
    for (const e of batch) {
      insertEvent.run({
        id: e.id,
        ledger_seq: e.seq,
        ts: e.ts,
        event_type: e.type,
        node_id: e.target?.node_id ?? null,
        edge_id: e.target?.edge_id ?? null,
        branch_id: e.target?.branch_id ?? null,
        repo_id: e.target?.repo_id ?? null,
        workspace_id: e.target?.workspace_id ?? null,
        origin: e.origin,
        method: e.method,
        payload: JSON.stringify(e.payload ?? {}),
        provenance: JSON.stringify(e.provenance ?? {}),
      });

      const p = (e.payload ?? {}) as Record<string, unknown>;
      switch (e.type) {
        case "node_alias_added": {
          const nodeId = e.target?.node_id;
          if (!nodeId) break;
          const identity = lookupIdentity.get(nodeId) as
            | { identity_key: string }
            | undefined;
          upsertAlias.run({
            id: `alias_${e.id}`,
            node_id: nodeId,
            alias_key: String(p.alias_key ?? ""),
            alias_type: String(p.alias_type ?? "qualified_name"),
            current_identity_key: identity?.identity_key ?? null,
            valid_from: e.ts,
            reason: p.reason == null ? null : String(p.reason),
            confidence: typeof p.confidence === "number" ? p.confidence : 1.0,
            created_at: e.ts,
          });
          break;
        }
        case "manual_edge_created": {
          insertEdge.run({
            id: `edge_${e.id}`,
            src: String(p.src ?? e.target?.node_id ?? ""),
            dst: p.dst == null ? null : String(p.dst),
            raw_target: p.raw_target == null ? null : String(p.raw_target),
            edge_type: String(p.edge_type ?? "wikilink"),
            branch_id: e.target?.branch_id ?? null,
            origin: e.origin,
            method: e.method,
            confidence: typeof p.confidence === "number" ? p.confidence : 1.0,
            provenance: JSON.stringify(e.provenance ?? {}),
          });
          break;
        }
        case "alias_merge_undone": {
          undoAlias.run({
            valid_to: e.ts,
            node_id: e.target?.node_id ?? "",
            alias_key: String(p.alias_key ?? ""),
            alias_type: String(p.alias_type ?? "qualified_name"),
          });
          break;
        }
        default:
          break; // 其余类型只落 events 行（V1）
      }
    }
    const last = batch[batch.length - 1];
    advance.run(last.seq, new Date().toISOString());
  });

  run(pending);
  return { applied: pending.length };
}
```

`packages/knowledge-core/src/index.ts` 追加：

```typescript
export { materialize } from "./materializer.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-materializer.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-materializer.test.mjs
git commit -m "feat(knowledge): ledger materializer — events/aliases/edges with resumable seq tracking"
```

---

### Task 7: KnowledgeStore（写路径收口 + 解析直写防护）

**Files:**
- Create: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-store.test.mjs`

**Interfaces:**
- Consumes: `Ledger`（Task 3/4）、`openDatabase`（Task 5）、`materialize`（Task 6）
- Produces:
  - `class KnowledgeStore`：
    - `KnowledgeStore.open({ dbPath, ledgerPath }): KnowledgeStore` —— 打开时自动 replay 追平（启动一致性）
    - `recordKnowledge(input: LedgerEventInput): LedgerEvent` —— **不可再生知识唯一写入口**：append → materialize
    - `upsertNode(n: { nodeType: string; identityKey: string; repoId?: string | null; title: string; meta?: Record<string, unknown> }): string` —— 解析直写；UNIQUE 冲突时更新 title/meta，返回 node id
    - `replaceFileEdges(p: { branchId: string; filePath: string; edges: ParsedEdge[] }): void` —— 解析直写；**断言每条 `origin === "parser"`，否则抛错**；按 `provenance.file = filePath` + branch 先删后插
    - `type ParsedEdge = { src: string; dst: string | null; rawTarget?: string | null; edgeType: string; origin: "parser"; method: "EXTRACTED" | "INFERRED"; confidence?: number }`
    - `getNode(id): NodeRow | null`、`close()`
    - 暴露 `store.db`（只读用途，测试与上层查询）

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-store.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-store-"));
  return {
    dir,
    store: KnowledgeStore.open({
      dbPath: join(dir, "knowledge.db"),
      ledgerPath: join(dir, "ledger.jsonl"),
    }),
  };
}

test("recordKnowledge appends to ledger first, then materializes", () => {
  const { dir, store } = openTemp();
  const noteId = store.upsertNode({
    nodeType: "note", identityKey: "cases/demo.md", title: "Demo",
  });
  const symId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  const event = store.recordKnowledge({
    type: "manual_edge_created",
    origin: "user",
    method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: noteId },
    payload: { src: noteId, dst: symId, edge_type: "wikilink" },
  });

  const ledgerLines = readFileSync(join(dir, "ledger.jsonl"), "utf8")
    .trim().split("\n");
  assert.equal(ledgerLines.length, 1);
  assert.equal(JSON.parse(ledgerLines[0]).id, event.id);

  const edge = store.db
    .prepare("SELECT * FROM edges WHERE id = ?").get(`edge_${event.id}`);
  assert.equal(edge.src, noteId);
  assert.equal(edge.dst, symId);
  store.close();
});

test("upsertNode is idempotent on (node_type, identity_key)", () => {
  const { store } = openTemp();
  const id1 = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:X.foo", title: "foo",
  });
  const id2 = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:X.foo", title: "foo (updated)",
  });
  assert.equal(id1, id2);
  assert.equal(store.getNode(id1).title, "foo (updated)");
  store.close();
});

test("replaceFileEdges rejects non-parser edges (§2.2 iron rule)", () => {
  const { store } = openTemp();
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "r:a", title: "a" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: "r:b", title: "b" });
  store.db.prepare(
    "INSERT INTO repos (id, name, root_path, created_at) VALUES ('repo1','r','/tmp/r','2026-07-07T00:00:00Z')",
  ).run();
  store.db.prepare(
    "INSERT INTO branches (id, repo_id, name, status) VALUES ('br1','repo1','main','live')",
  ).run();

  assert.throws(
    () =>
      store.replaceFileEdges({
        branchId: "br1",
        filePath: "src/a.ts",
        edges: [{ src: a, dst: b, edgeType: "calls", origin: "user", method: "ASSERTED" }],
      }),
    /recordKnowledge/,
  );
  store.close();
});

test("replaceFileEdges replaces edges for the same file+branch", () => {
  const { store } = openTemp();
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "r:a", title: "a" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: "r:b", title: "b" });
  const c = store.upsertNode({ nodeType: "symbol", identityKey: "r:c", title: "c" });
  store.db.prepare(
    "INSERT INTO repos (id, name, root_path, created_at) VALUES ('repo1','r','/tmp/r','2026-07-07T00:00:00Z')",
  ).run();
  store.db.prepare(
    "INSERT INTO branches (id, repo_id, name, status) VALUES ('br1','repo1','main','live')",
  ).run();

  const mk = (dst) => ({
    src: a, dst, edgeType: "calls", origin: "parser", method: "EXTRACTED",
  });
  store.replaceFileEdges({ branchId: "br1", filePath: "src/a.ts", edges: [mk(b)] });
  store.replaceFileEdges({ branchId: "br1", filePath: "src/a.ts", edges: [mk(c)] });

  const rows = store.db
    .prepare("SELECT dst FROM edges WHERE src = ? AND branch_id = 'br1'").all(a);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dst, c);
  store.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store.test.mjs`
Expected: FAIL —— `KnowledgeStore` 未导出

- [ ] **Step 3: 实现**

`packages/knowledge-core/src/store.ts`：

```typescript
import { randomUUID } from "node:crypto";
import type DatabaseCtor from "better-sqlite3";
import { Ledger, readLedgerFile } from "./ledger.js";

type Database = DatabaseCtor.Database;
import type { LedgerEvent, LedgerEventInput } from "./ledger.js";
import { materialize } from "./materializer.js";
import { openDatabase } from "./schema.js";

export interface ParsedEdge {
  src: string;
  dst: string | null;
  rawTarget?: string | null;
  edgeType: string;
  origin: "parser";
  method: "EXTRACTED" | "INFERRED";
  confidence?: number;
}

export interface NodeRow {
  id: string;
  node_type: string;
  identity_key: string;
  repo_id: string | null;
  title: string;
  meta: string;
  created_at: string;
}

// 存储核心唯一对外 API（D4 隔离层）。
// §2.2 铁律在代码层的收口点：不可再生知识只有 recordKnowledge() 一个入口，
// 本类不提供任何绕过账本写 events/node_aliases/非 parser 边的方法。
export class KnowledgeStore {
  private constructor(
    readonly db: Database,
    private readonly ledger: Ledger,
    readonly ledgerPath: string,
  ) {}

  static open(opts: { dbPath: string; ledgerPath: string }): KnowledgeStore {
    const db = openDatabase(opts.dbPath);
    const { ledger, read } = Ledger.open(opts.ledgerPath);
    materialize(db, read.events); // 启动追平：账本领先则 replay
    return new KnowledgeStore(db, ledger, opts.ledgerPath);
  }

  close(): void {
    this.db.close();
  }

  // —— 不可再生知识唯一写入口：先账本，后物化 ——
  recordKnowledge(input: LedgerEventInput): LedgerEvent {
    const event = this.ledger.append(input);
    materialize(this.db, [event]);
    return event;
  }

  // —— 解析衍生（可再生）直写 ——
  upsertNode(n: {
    nodeType: string;
    identityKey: string;
    repoId?: string | null;
    title: string;
    meta?: Record<string, unknown>;
  }): string {
    const existing = this.db
      .prepare("SELECT id FROM nodes WHERE node_type = ? AND identity_key = ?")
      .get(n.nodeType, n.identityKey) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE nodes SET title = ?, meta = ? WHERE id = ?")
        .run(n.title, JSON.stringify(n.meta ?? {}), existing.id);
      return existing.id;
    }
    const id = `node_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO nodes (id, node_type, identity_key, repo_id, title, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        n.nodeType,
        n.identityKey,
        n.repoId ?? null,
        n.title,
        JSON.stringify(n.meta ?? {}),
        new Date().toISOString(),
      );
    return id;
  }

  getNode(id: string): NodeRow | null {
    return (
      (this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
        | NodeRow
        | undefined) ?? null
    );
  }

  // 解析产出的代码边：同 file+branch 全量替换（§6.3 增量语义）。
  // 非 parser 边在这里是实现错误，不是数据——直接抛。
  replaceFileEdges(p: {
    branchId: string;
    filePath: string;
    edges: ParsedEdge[];
  }): void {
    for (const e of p.edges) {
      if (e.origin !== "parser") {
        throw new Error(
          `non-rebuildable edge (origin=${e.origin}) must go through recordKnowledge() — spec §2.2`,
        );
      }
    }
    const del = this.db.prepare(
      `DELETE FROM edges WHERE branch_id = ? AND origin = 'parser'
       AND json_extract(provenance, '$.file') = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id,
         origin, method, confidence, provenance)
       VALUES (?, ?, ?, ?, ?, ?, 'parser', ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      del.run(p.branchId, p.filePath);
      for (const e of p.edges) {
        ins.run(
          `edge_${randomUUID()}`,
          e.src,
          e.dst,
          e.rawTarget ?? null,
          e.edgeType,
          p.branchId,
          e.method,
          e.confidence ?? 1.0,
          JSON.stringify({ file: p.filePath }),
        );
      }
    });
    tx();
  }
}
```

`packages/knowledge-core/src/index.ts` 追加：

```typescript
export {
  KnowledgeStore,
  type NodeRow,
  type ParsedEdge,
} from "./store.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-store.test.mjs
git commit -m "feat(knowledge): KnowledgeStore — ledger-first write path + parser-only direct writes"
```

---

### Task 8: FTS 索引 + searchText（敏感页排除）

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Test: `tests/knowledge-core-search.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `KnowledgeStore`、Task 5 的 `fts_notes`/`fts_symbols`/`notes_index`
- Produces（KnowledgeStore 新方法）：
  - `indexNoteText(p: { nodeId: string; path: string; title: string; body: string; frontmatter?: Record<string, unknown>; sensitive?: boolean; mcpAccess?: "allowed" | "denied"; contentHash: string }): void` —— upsert `notes_index` + 重建该行 FTS
  - `indexSymbolText(p: { nodeId: string; name: string; signature?: string | null }): void`
  - `searchText(query: string, opts?: { types?: string[]; includeSensitive?: boolean; limit?: number }): SearchHit[]`
  - `type SearchHit = { nodeId: string; nodeType: string; title: string; snippet: string | null }` —— 敏感/`mcp_access='denied'` 笔记默认排除

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-search.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-search-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function seed(store) {
  const note = store.upsertNode({
    nodeType: "note", identityKey: "cases/gameurl.md", title: "Brazil GameURL Issue",
  });
  store.indexNoteText({
    nodeId: note, path: "cases/gameurl.md", title: "Brazil GameURL Issue",
    body: "providerId 2043 returns empty gameURL", contentHash: "h1",
  });
  const secret = store.upsertNode({
    nodeType: "note", identityKey: "credentials/github.md", title: "Github Account",
  });
  store.indexNoteText({
    nodeId: secret, path: "credentials/github.md", title: "Github Account",
    body: "recovery codes for gameURL testing", sensitive: true,
    mcpAccess: "denied", contentHash: "h2",
  });
  const sym = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  store.indexSymbolText({
    nodeId: sym, name: "GetLoginURL", signature: "(req: LoginReq) => LoginRes",
  });
  return { note, secret, sym };
}

test("searchText finds notes and symbols", () => {
  const store = openTemp();
  const { note, sym } = seed(store);
  const hits = store.searchText("gameURL");
  const ids = hits.map((h) => h.nodeId);
  assert.ok(ids.includes(note));
  const symHits = store.searchText("GetLoginURL");
  assert.ok(symHits.map((h) => h.nodeId).includes(sym));
  store.close();
});

test("sensitive notes are excluded by default, included on opt-in", () => {
  const store = openTemp();
  const { secret } = seed(store);
  const def = store.searchText("gameURL");
  assert.ok(!def.map((h) => h.nodeId).includes(secret));
  const opted = store.searchText("gameURL", { includeSensitive: true });
  assert.ok(opted.map((h) => h.nodeId).includes(secret));
  store.close();
});

test("type filter narrows results", () => {
  const store = openTemp();
  seed(store);
  const hits = store.searchText("gameURL", { types: ["symbol"] });
  assert.ok(hits.every((h) => h.nodeType === "symbol"));
  store.close();
});

test("re-indexing a note replaces its FTS row (no duplicates)", () => {
  const store = openTemp();
  const { note } = seed(store);
  store.indexNoteText({
    nodeId: note, path: "cases/gameurl.md", title: "Brazil GameURL Issue",
    body: "updated body still gameURL", contentHash: "h1b",
  });
  const hits = store.searchText("gameURL").filter((h) => h.nodeId === note);
  assert.equal(hits.length, 1);
  store.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-search.test.mjs`
Expected: FAIL —— `indexNoteText` 不是函数

- [ ] **Step 3: 实现（在 store.ts 的 KnowledgeStore 类内追加方法，并在文件顶部补类型）**

`packages/knowledge-core/src/store.ts` 顶部追加类型：

```typescript
export interface SearchHit {
  nodeId: string;
  nodeType: string;
  title: string;
  snippet: string | null;
}
```

KnowledgeStore 类内追加：

```typescript
  indexNoteText(p: {
    nodeId: string;
    path: string;
    title: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    sensitive?: boolean;
    mcpAccess?: "allowed" | "denied";
    contentHash: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes_index (node_id, path, frontmatter, sensitive, ai_access, mcp_access, content_hash)
           VALUES (@node_id, @path, @frontmatter, @sensitive, 'allowed', @mcp_access, @content_hash)
           ON CONFLICT (node_id) DO UPDATE SET
             path = @path, frontmatter = @frontmatter, sensitive = @sensitive,
             mcp_access = @mcp_access, content_hash = @content_hash`,
        )
        .run({
          node_id: p.nodeId,
          path: p.path,
          frontmatter: JSON.stringify(p.frontmatter ?? {}),
          sensitive: p.sensitive ? 1 : 0,
          mcp_access: p.mcpAccess ?? "allowed",
          content_hash: p.contentHash,
        });
      this.db.prepare("DELETE FROM fts_notes WHERE node_id = ?").run(p.nodeId);
      this.db
        .prepare("INSERT INTO fts_notes (node_id, title, body) VALUES (?, ?, ?)")
        .run(p.nodeId, p.title, p.body);
    });
    tx();
  }

  indexSymbolText(p: {
    nodeId: string;
    name: string;
    signature?: string | null;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM fts_symbols WHERE node_id = ?").run(p.nodeId);
      this.db
        .prepare(
          "INSERT INTO fts_symbols (node_id, name, signature) VALUES (?, ?, ?)",
        )
        .run(p.nodeId, p.name, p.signature ?? "");
    });
    tx();
  }

  searchText(
    query: string,
    opts?: { types?: string[]; includeSensitive?: boolean; limit?: number },
  ): SearchHit[] {
    const limit = opts?.limit ?? 50;
    // FTS5 查询串加引号转义，避免用户输入被当作查询语法
    const match = `"${query.replace(/"/g, '""')}"`;

    const noteRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                snippet(fts_notes, 2, '[', ']', '…', 12) AS snippet
         FROM fts_notes f
         JOIN nodes n ON n.id = f.node_id
         JOIN notes_index ni ON ni.node_id = f.node_id
         WHERE fts_notes MATCH ?
           AND (? = 1 OR (ni.sensitive = 0 AND ni.mcp_access = 'allowed'))
         LIMIT ?`,
      )
      .all(match, opts?.includeSensitive ? 1 : 0, limit) as SearchHit[];

    const symbolRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                NULL AS snippet
         FROM fts_symbols f
         JOIN nodes n ON n.id = f.node_id
         WHERE fts_symbols MATCH ?
         LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];

    let hits = [...noteRows, ...symbolRows];
    if (opts?.types?.length) {
      hits = hits.filter((h) => opts.types!.includes(h.nodeType));
    }
    return hits.slice(0, limit);
  }
```

`packages/knowledge-core/src/index.ts` 的 store 导出行更新为：

```typescript
export {
  KnowledgeStore,
  type NodeRow,
  type ParsedEdge,
  type SearchHit,
} from "./store.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-search.test.mjs`
Expected: `pass 4`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-search.test.mjs
git commit -m "feat(knowledge): FTS indexing + searchText with sensitive-page exclusion"
```

---

### Task 9: 身份解析（identity → alias 回退）

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/knowledge-core-store.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 6 的 alias 物化、Task 7 的 `recordKnowledge`/`upsertNode`
- Produces（KnowledgeStore 新方法）：
  - `resolveIdentity(key: string): { nodeId: string; via: "identity" | "alias" } | null` —— 先查 `nodes.identity_key`，再查 `node_aliases.alias_key`（只认 `valid_to IS NULL` 的现行 alias）
  - `getAliases(nodeId: string): Array<{ aliasKey: string; aliasType: string; reason: string | null; validFrom: string | null; validTo: string | null }>`

- [ ] **Step 1: 追加失败测试**

在 `tests/knowledge-core-store.test.mjs` 追加：

```javascript
test("resolveIdentity falls back to alias after rename (D13)", () => {
  const { store } = openTemp();
  const nodeId = store.upsertNode({
    nodeType: "symbol",
    identityKey: "repo:UserService.signIn",
    title: "UserService.signIn",
  });
  // rename 检测产生的 alias：旧名 login → 同一节点
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system",
    method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:UserService.login", alias_type: "qualified_name", reason: "rename" },
  });

  assert.deepEqual(store.resolveIdentity("repo:UserService.signIn"), {
    nodeId, via: "identity",
  });
  assert.deepEqual(store.resolveIdentity("repo:UserService.login"), {
    nodeId, via: "alias",
  });
  assert.equal(store.resolveIdentity("repo:NoSuch"), null);

  const aliases = store.getAliases(nodeId);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].aliasKey, "repo:UserService.login");
  assert.equal(aliases[0].reason, "rename");
  store.close();
});

test("undone alias no longer resolves", () => {
  const { store } = openTemp();
  const nodeId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:A.b", title: "A.b",
  });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system", method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:A.old", alias_type: "qualified_name", reason: "rename" },
  });
  store.recordKnowledge({
    type: "alias_merge_undone",
    origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:A.old", alias_type: "qualified_name" },
  });
  assert.equal(store.resolveIdentity("repo:A.old"), null);
  store.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store.test.mjs`
Expected: FAIL —— `resolveIdentity` 不是函数

- [ ] **Step 3: 实现（KnowledgeStore 类内追加）**

```typescript
  resolveIdentity(
    key: string,
  ): { nodeId: string; via: "identity" | "alias" } | null {
    const direct = this.db
      .prepare("SELECT id FROM nodes WHERE identity_key = ?")
      .get(key) as { id: string } | undefined;
    if (direct) return { nodeId: direct.id, via: "identity" };

    const alias = this.db
      .prepare(
        `SELECT node_id FROM node_aliases
         WHERE alias_key = ? AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(key) as { node_id: string } | undefined;
    if (alias) return { nodeId: alias.node_id, via: "alias" };
    return null;
  }

  getAliases(nodeId: string): Array<{
    aliasKey: string;
    aliasType: string;
    reason: string | null;
    validFrom: string | null;
    validTo: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT alias_key AS aliasKey, alias_type AS aliasType, reason,
                valid_from AS validFrom, valid_to AS validTo
         FROM node_aliases WHERE node_id = ? ORDER BY created_at`,
      )
      .all(nodeId) as Array<{
      aliasKey: string;
      aliasType: string;
      reason: string | null;
      validFrom: string | null;
      validTo: string | null;
    }>;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store.test.mjs`
Expected: `pass 6`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src tests/knowledge-core-store.test.mjs
git commit -m "feat(knowledge): identity resolution with alias fallback (D13)"
```

---

### Task 10: 一致性检查 + 删库重建

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/knowledge-core-recovery.test.mjs`

**Interfaces:**
- Consumes: 前面全部
- Produces（KnowledgeStore 新方法）：
  - `consistencyCheck(): { ledgerSeq: number; materializedSeq: number; status: "ok" | "index_behind"; ledgerTruncatedAtLine: number | null }` —— 重新读账本文件对账；`index_behind` 时自动 replay 追平后返回追平后的状态
  - 隐含保证（open 时已实现）：`knowledge.db` 被删 → `KnowledgeStore.open` 全量 replay，账本物化内容（aliases/manual edges/events）逐行重现，且物化行 id 与删库前一致（确定性派生）

- [ ] **Step 1: 写失败测试**

`tests/knowledge-core-recovery.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "pk-recover-"));
  return { dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") };
}

function seedKnowledge(store) {
  const noteId = store.upsertNode({
    nodeType: "note", identityKey: "cases/demo.md", title: "Demo",
  });
  const symId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  const ev = store.recordKnowledge({
    type: "manual_edge_created",
    origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: noteId },
    payload: { src: noteId, dst: symId, edge_type: "wikilink" },
  });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system", method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: symId },
    payload: { alias_key: "repo:OldLoginURL", alias_type: "qualified_name", reason: "rename" },
  });
  return { noteId, symId, edgeEventId: ev.id };
}

test("deleting knowledge.db and reopening replays ledger deterministically", () => {
  const p = paths();
  const store1 = KnowledgeStore.open(p);
  const { edgeEventId } = seedKnowledge(store1);
  store1.close();

  rmSync(p.dbPath);
  rmSync(p.dbPath + "-wal", { force: true });
  rmSync(p.dbPath + "-shm", { force: true });

  const store2 = KnowledgeStore.open(p);
  // 账本物化内容重现（node 是解析衍生，重建由上层索引器负责——
  // 这里验证 Ledger 部分：events + edges + aliases 全部回来了，且 id 一致）
  const edge = store2.db
    .prepare("SELECT * FROM edges WHERE id = ?").get(`edge_${edgeEventId}`);
  assert.ok(edge, "manual edge must be rematerialized with the same id");
  assert.equal(
    store2.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2,
  );
  assert.equal(
    store2.db.prepare("SELECT COUNT(*) AS n FROM node_aliases").get().n, 1,
  );
  const state = store2.db
    .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'").get();
  assert.equal(state.materialized_seq, 2);
  store2.close();
});

test("consistencyCheck reports and repairs index_behind", () => {
  const p = paths();
  const store = KnowledgeStore.open(p);
  seedKnowledge(store);
  // 人为回拨 materialized_seq，模拟「账本已写、物化未完成」的崩溃
  store.db
    .prepare("UPDATE ledger_state SET materialized_seq = 0 WHERE id='main'")
    .run();
  store.db.prepare("DELETE FROM events").run();
  store.db.prepare("DELETE FROM node_aliases").run();
  store.db.prepare("DELETE FROM edges WHERE origin != 'parser'").run();

  const result = store.consistencyCheck();
  assert.equal(result.status, "ok"); // 自动追平后返回
  assert.equal(result.ledgerSeq, 2);
  assert.equal(result.materializedSeq, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  store.close();
});

test("consistencyCheck surfaces ledger truncation info", () => {
  const p = paths();
  const store = KnowledgeStore.open(p);
  seedKnowledge(store);
  appendFileSync(p.ledgerPath, "corrupted-tail\n");
  const result = store.consistencyCheck();
  assert.equal(result.ledgerTruncatedAtLine, 3);
  assert.equal(result.status, "ok");
  store.close();
});
```

（注意文件顶部 import 需为 `import { appendFileSync, mkdtempSync, rmSync } from "node:fs";`）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-recovery.test.mjs`
Expected: FAIL —— `consistencyCheck` 不是函数（第一个删库用例应已通过：open 即 replay）

- [ ] **Step 3: 实现（KnowledgeStore 类内追加）**

```typescript
  // §9：启动/定期对账。账本领先 → 自动 replay 追平；
  // 账本尾部损坏 → 报告截断行（有效前缀照常使用），不阻塞。
  consistencyCheck(): {
    ledgerSeq: number;
    materializedSeq: number;
    status: "ok" | "index_behind";
    ledgerTruncatedAtLine: number | null;
  } {
    const read = readLedgerFile(this.ledgerPath);
    const ledgerSeq =
      read.events.length > 0 ? read.events[read.events.length - 1].seq : 0;
    let state = this.db
      .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
      .get() as { materialized_seq: number };

    if (state.materialized_seq < ledgerSeq) {
      materialize(this.db, read.events);
      state = this.db
        .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
        .get() as { materialized_seq: number };
    }

    return {
      ledgerSeq,
      materializedSeq: state.materialized_seq,
      status: state.materialized_seq >= ledgerSeq ? "ok" : "index_behind",
      ledgerTruncatedAtLine: read.truncatedAtLine,
    };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-recovery.test.mjs`
Expected: `pass 3`

- [ ] **Step 5: 全量回归 + Commit**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-scaffold.test.mjs tests/knowledge-core-canonical.test.mjs tests/knowledge-core-ledger.test.mjs tests/knowledge-core-schema.test.mjs tests/knowledge-core-materializer.test.mjs tests/knowledge-core-store.test.mjs tests/knowledge-core-search.test.mjs tests/knowledge-core-recovery.test.mjs`
Expected: 全部 pass（34 个用例：1+4+8+4+4+6+4+3）

Run: `pnpm test`
Expected: 原有测试无回归

```bash
git add packages/knowledge-core/src tests/knowledge-core-recovery.test.mjs
git commit -m "feat(knowledge): consistency check + rebuild-from-ledger recovery"
```

---

## 完成定义（Plan 1 出口条件）

- [ ] `pnpm test` 全绿（新旧测试）
- [ ] `pnpm typecheck` 通过
- [ ] §2.2 铁律在代码层成立：grep `INSERT INTO events`、`INSERT INTO node_aliases`——只出现在 `materializer.ts`
- [ ] 后续计划的消费接口就绪：`KnowledgeStore.open / recordKnowledge / upsertNode / replaceFileEdges / indexNoteText / indexSymbolText / searchText / resolveIdentity / getAliases / consistencyCheck`

## 显式不在本计划（后续计划承接）

- Wiki 扫描/frontmatter/wikilink 解析 → 计划 2
- tree-sitter、branches 感知、rename 检测、chokidar → 计划 3（rename 检测产出的 `node_alias_added` 事件走本计划的 `recordKnowledge`）
- MCP 六件套 → 计划 4（只依赖本计划的公开 API + 计划 2/3 的数据）
- UI / Tauri 命令 → 计划 5
- symbol_versions 的 upsert 辅助方法：计划 3 需要时在 KnowledgeStore 上按同模式追加（直写合法：解析衍生）
- CLI 薄壳（`penguin init/search/callers/...`，spec §8.3）→ 计划 6——直接消费本计划的公开 API；跨进程账本锁已在本计划 Task 3 落地，CLI 无需额外并发处理
