import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
