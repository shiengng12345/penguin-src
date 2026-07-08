import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { extractSymbols, indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const CTRL = [
  "@Controller('users')",
  "export class UsersController {",
  "  @Get(':id')",
  "  findOne(id) { return this.svc.findOne(id); }",
  "  @Post()",
  "  create(dto) { return this.svc.create(dto); }",
  "}",
].join("\n");

test("extractSymbols: controller + verb decorators → normalized routes (P2)", async () => {
  const out = await extractSymbols({ lang: "ts", source: CTRL });
  const byPath = Object.fromEntries(out.routes.map((r) => [`${r.httpMethod} ${r.routePath}`, r]));
  assert.ok(byPath["GET /users/:id"], "GET /users/:id");
  assert.equal(byPath["GET /users/:id"].handlerQualifiedName, "UsersController.findOne");
  assert.ok(byPath["POST /users"], "POST /users (empty method path → base only)");
  assert.equal(byPath["POST /users"].handlerQualifiedName, "UsersController.create");
});

test("extractSymbols: non-controller class yields no routes; non-ts empty", async () => {
  const plain = await extractSymbols({ lang: "ts", source: "export class PlainService { run() {} }" });
  assert.equal(plain.routes.length, 0);
  const py = await extractSymbols({ lang: "python", source: "def f():\n  pass\n" });
  assert.deepEqual(py.routes, []);
});

test("indexRepo: route nodes + handles edges to handler methods (P2)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-routes-"));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "users.controller.ts"), CTRL);

  const dir = mkdtempSync(join(tmpdir(), "pk-routes-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const r = await indexRepo({ store, rootPath: root, mode: "incremental" });

  const route = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='route' AND identity_key=?")
    .get(`${r.repoId}::route::GET /users/:id`);
  assert.ok(route, "route node created");
  const handler = store.resolveIdentity(`${r.repoId}::UsersController.findOne`);
  const handles = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='handles' AND src=? AND dst=?")
    .get(route.id, handler.nodeId);
  assert.equal(handles.n, 1, "route → handler 'handles' edge");
  store.close();
});

test("indexRepo: throw + process.env → error/env entity nodes + edges (P3)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-ent-"));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "svc.ts"),
    "export function load() {\n  const s = process.env.JWT_SECRET;\n  if (!s) throw new ConfigError('missing');\n  return s;\n}",
  );
  const dir = mkdtempSync(join(tmpdir(), "pk-ent-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const r = await indexRepo({ store, rootPath: root, mode: "incremental" });

  const err = store.db.prepare("SELECT id FROM nodes WHERE node_type='entity' AND identity_key=?").get(`${r.repoId}::entity::error::ConfigError`);
  const env = store.db.prepare("SELECT id FROM nodes WHERE node_type='entity' AND identity_key=?").get(`${r.repoId}::entity::env::JWT_SECRET`);
  assert.ok(err && env, "error + env entity nodes created");
  const load = store.resolveIdentity(`${r.repoId}::load`);
  const throws = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='throws' AND src=? AND dst=?").get(load.nodeId, err.id);
  const uses = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='uses' AND src=? AND dst=?").get(load.nodeId, env.id);
  assert.equal(throws.n, 1, "load →throws→ ConfigError");
  assert.equal(uses.n, 1, "load →uses→ JWT_SECRET");
  store.close();
});
