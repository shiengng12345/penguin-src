import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
import {
  Ledger,
  eventChecksum,
  readLedgerFile,
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

test("stale lock (>30s old) is reclaimed instead of timing out", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  const lockPath = path + ".lock";
  writeFileSync(lockPath, "");
  const old = new Date(Date.now() - 31_000);
  utimesSync(lockPath, old, old);
  const start = Date.now();
  const e = ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z");
  const elapsed = Date.now() - start;
  assert.equal(e.seq, 1);
  assert.ok(elapsed < 3000, `stale lock should be reclaimed fast, took ${elapsed}ms`);
});

test("two real OS processes appending concurrently never collide on seq", async () => {
  const path = tempLedgerPath();
  const distUrl = pathToFileURL(
    new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname,
  ).href;
  const childSrc = `
    const { Ledger } = await import(${JSON.stringify(distUrl)});
    const { ledger } = Ledger.open(process.argv[1]);
    const input = { type: "manual_edge_created", origin: "user", method: "ASSERTED", actor: { type: "user", id: "child" }, payload: {} };
    for (let i = 0; i < 25; i++) ledger.append(input);
  `;
  await Promise.all([
    execFileP(process.execPath, ["--input-type=module", "-e", childSrc, path]),
    execFileP(process.execPath, ["--input-type=module", "-e", childSrc, path]),
  ]);
  const seqs = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).seq)
    .sort((a, b) => a - b);
  assert.equal(seqs.length, 50);
  assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
});

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

test("append HEALS a corrupt tail so replay keeps the new event (Critical)", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z"); // seq 1
  // 模拟崩溃残留：坏行卡在文件尾部
  appendFileSync(path, "not-json-crash-tail\n");

  // 未修复前：readLedgerFile 在坏行停止，只见 seq 1
  assert.equal(readLedgerFile(path).events.length, 1);

  // append 应先修复再写：新事件成为可读的 seq 2
  const e2 = ledger.append(INPUT, () => "2026-07-07T10:00:04.000Z");
  assert.equal(e2.seq, 2);

  // 关键：重放现在能看到两条事件、无截断——新写入不再蒸发
  const after = readLedgerFile(path);
  assert.equal(after.events.length, 2);
  assert.equal(after.truncatedAtLine, null);
  assert.deepEqual(after.events.map((e) => e.seq), [1, 2]);
  // 坏尾被存档而非丢弃
  assert.ok(existsSync(path + ".corrupt"));
  assert.match(readFileSync(path + ".corrupt", "utf8"), /not-json-crash-tail/);
});

test("append heals a half-written (newline-less) tail without gluing", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  ledger.append(INPUT, () => "2026-07-07T10:00:00.000Z"); // seq 1
  appendFileSync(path, '{"seq":2,"id":"led_x","ts":"2026-07-0'); // 写一半、无换行

  const e2 = ledger.append(INPUT, () => "2026-07-07T10:00:05.000Z");
  assert.equal(e2.seq, 2);
  const after = readLedgerFile(path);
  assert.deepEqual(after.events.map((e) => e.seq), [1, 2]);
  assert.equal(after.truncatedAtLine, null);
});

test("payload with a non-JSON-safe value (Date) round-trips + checksum holds", () => {
  const path = tempLedgerPath();
  const { ledger } = Ledger.open(path);
  const e = ledger.append(
    { ...INPUT, payload: { when: new Date("2026-07-07T10:00:00.000Z"), n: 1 } },
    () => "2026-07-07T10:00:00.000Z",
  );
  // Date 已归一化为 ISO 串，两种序列化一致
  assert.equal(e.payload.when, "2026-07-07T10:00:00.000Z");
  const read = readLedgerFile(path);
  assert.equal(read.truncatedAtLine, null, "checksum must not fail on Date payload");
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].payload.when, "2026-07-07T10:00:00.000Z");
});
