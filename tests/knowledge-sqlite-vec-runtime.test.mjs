import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("sqlite-vec is an isolated native release dependency", () => {
  const source = resolve("packages/knowledge-cli/bundle");
  const dir = mkdtempSync(join(tmpdir(), "penguin-vec-runtime-"));
  const runtime = join(dir, "runtime");
  cpSync(source, runtime, { recursive: true });
  try {
    const result = spawnSync(join(runtime, "node"), ["-e", `
      const Database=require('better-sqlite3');
      const vec=require('sqlite-vec');
      if (!vec.getLoadablePath().startsWith(process.cwd())) throw new Error('sqlite-vec escaped isolated runtime');
      const db=new Database(':memory:'); vec.load(db);
      db.exec('create virtual table test_vectors using vec0(embedding float[3])');
      db.prepare('insert into test_vectors(embedding) values (?)').run(Buffer.from(new Float32Array([0,1,0]).buffer));
      const result=db.prepare('select distance from test_vectors where embedding match ? and k=1').get(Buffer.from(new Float32Array([0,1,0]).buffer));
      if (!result || result.distance !== 0) throw new Error('sqlite-vec query failed');
      db.close();
    `], { cwd: runtime, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_PATH: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite-vec bundle contains the architecture-specific extension", () => {
  const packageName = `sqlite-vec-darwin-${process.arch}`;
  assert.equal(existsSync(resolve("packages/knowledge-cli/bundle/node_modules", packageName, "vec0.dylib")), true);
});
