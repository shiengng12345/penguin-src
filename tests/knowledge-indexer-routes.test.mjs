import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { extractSymbols, indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const HTTP_CTRL = [
  "@Controller('users')",
  "export class UsersController {",
  "  @Get(':id')",
  "  findOne(id) { return this.svc.findOne(id); }",
  "  @Post()",
  "  create(dto) { return this.svc.create(dto); }",
  "}",
].join("\n");

function tempGitRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-ep-db-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("extractSymbols: HTTP controller → endpoints (P2)", async () => {
  const out = await extractSymbols({ lang: "ts", source: HTTP_CTRL });
  const keys = out.endpoints.map((e) => e.key);
  assert.ok(keys.includes("GET /users/:id"), "GET /users/:id");
  assert.ok(keys.includes("POST /users"), "POST /users");
});

test("extractSymbols: HTTP endpoints carry a success status (P2#8)", async () => {
  const src = [
    "@Controller('users')",
    "export class UsersController {",
    "  @Get(':id')",
    "  findOne(id) { return id; }",
    "  @Post()",
    "  create(dto) { return dto; }",
    "  @HttpCode(204)",
    "  @Delete(':id')",
    "  remove(id) { return id; }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  const byKey = Object.fromEntries(out.endpoints.map((e) => [e.key, e.httpStatus]));
  assert.equal(byKey["GET /users/:id"], 200, "GET defaults to 200");
  assert.equal(byKey["POST /users"], 201, "POST defaults to 201");
  assert.equal(byKey["DELETE /users/:id"], 204, "@HttpCode(204) wins");
});

test("extractSymbols: @GrpcMethod → grpc endpoint with service+method", async () => {
  const src = [
    "@Controller()",
    "export class PushController {",
    "  @GrpcMethod('PushService', 'SendPush')",
    "  async sendPush(data) { return this.svc.send(data); }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  const grpc = out.endpoints.find((e) => e.protocol === "grpc");
  assert.ok(grpc, "grpc endpoint extracted");
  assert.equal(grpc.grpcService, "PushService");
  assert.equal(grpc.grpcMethod, "SendPush");
  assert.equal(grpc.handlerQualifiedName, "PushController.sendPush");
});

test("extractSymbols: getService proxy calls → grpc client invocations", async () => {
  const src = [
    "export class NotifyService {",
    "  private pushService;",
    "  onInit() { this.pushService = this.client.getService('PushService'); }",
    "  async notify() { return this.pushService.sendPush({}); }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  const call = out.grpcClientCalls.find((c) => c.service === "PushService" && c.method === "sendPush");
  assert.ok(call, "grpc client call detected");
  assert.equal(call.enclosingQualifiedName, "NotifyService.notify");
});

test("indexRepo: CROSS-REPO gRPC — provider handles + consumer invokes the same global endpoint", async () => {
  const store = openStore();

  // repo B: provider
  const provider = tempGitRepo("pk-provider-");
  writeFileSync(
    join(provider, "src", "push.controller.ts"),
    ["@Controller()", "export class PushController {", "  @GrpcMethod('PushService', 'SendPush')", "  async sendPush(data) { return data; }", "}"].join("\n"),
  );
  const rB = await indexRepo({ store, rootPath: provider, mode: "incremental" });

  // repo A: consumer (separate repo, same store)
  const consumer = tempGitRepo("pk-consumer-");
  writeFileSync(
    join(consumer, "src", "notify.service.ts"),
    ["export class NotifyService {", "  private pushService;", "  onInit() { this.pushService = this.client.getService('PushService'); }", "  async notify() { return this.pushService.sendPush({}); }", "}"].join("\n"),
  );
  const rA = await indexRepo({ store, rootPath: consumer, mode: "incremental" });

  assert.notEqual(rA.repoId, rB.repoId, "two distinct repos");

  // one GLOBAL endpoint node, repo_id NULL, shared across repos
  const ep = store.db
    .prepare("SELECT id, repo_id FROM nodes WHERE node_type='endpoint' AND identity_key='grpc::PushService.sendpush'")
    .get();
  assert.ok(ep, "global grpc endpoint node exists");
  assert.equal(ep.repo_id, null, "endpoint belongs to no single repo");

  // provider handles it
  const handler = store.resolveIdentity(`${rB.repoId}::PushController.sendPush`);
  const handles = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='handles' AND src=? AND dst=?").get(ep.id, handler.nodeId);
  assert.equal(handles.n, 1, "provider → handles → endpoint");

  // consumer (OTHER repo) invokes it → cross-repo connection through the endpoint
  const caller = store.resolveIdentity(`${rA.repoId}::NotifyService.notify`);
  const invokes = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='invokes' AND src=? AND dst=?").get(caller.nodeId, ep.id);
  assert.equal(invokes.n, 1, "consumer → invokes → endpoint (cross-repo)");
  store.close();
});

test("indexRepo: throw + process.env → error/env entity nodes + edges (P3)", async () => {
  const root = tempGitRepo("pk-ent-");
  writeFileSync(
    join(root, "src", "svc.ts"),
    "export function load() {\n  const s = process.env.JWT_SECRET;\n  if (!s) throw new ConfigError('missing');\n  return s;\n}",
  );
  const store = openStore();
  const r = await indexRepo({ store, rootPath: root, mode: "incremental" });

  const err = store.db.prepare("SELECT id FROM nodes WHERE node_type='entity' AND identity_key=?").get(`${r.repoId}::entity::error::ConfigError`);
  const env = store.db.prepare("SELECT id FROM nodes WHERE node_type='entity' AND identity_key=?").get(`${r.repoId}::entity::env::JWT_SECRET`);
  assert.ok(err && env, "error + env entity nodes created");
  const load = store.resolveIdentity(`${r.repoId}::src/svc.ts::load`);
  const throws = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='throws' AND src=? AND dst=?").get(load.nodeId, err.id);
  const uses = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='uses' AND src=? AND dst=?").get(load.nodeId, env.id);
  assert.equal(throws.n, 1, "load →throws→ ConfigError");
  assert.equal(uses.n, 1, "load →uses→ JWT_SECRET");
  store.close();
});
