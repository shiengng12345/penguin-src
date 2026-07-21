// tests/grpc-native-sidecar.test.mjs
// SIDECAR_SCRIPT proto loading: imports inside a package's protos must
// resolve against that package's own proto dirs only (no cross-package
// shadowing when several installed packages ship a same-named proto, e.g.
// common.proto), and proto load errors must surface in the "Service not
// found" message instead of being swallowed.
//
// The sidecar needs real @grpc/grpc-js + @grpc/proto-loader at runtime; we
// borrow them from the user-level ~/.penguin/grpc install and skip honestly
// when this machine doesn't have one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { buildGrpcNativeScript } from "../packages/core/dist/index.js";

const GRPC_MODULES = join(homedir(), ".penguin", "grpc", "node_modules", "@grpc");
const hasGrpcRuntime =
  existsSync(join(GRPC_MODULES, "grpc-js")) && existsSync(join(GRPC_MODULES, "proto-loader"));
const skipOpts = hasGrpcRuntime
  ? {}
  : { skip: "no @grpc runtime under ~/.penguin/grpc on this machine" };

// packages: { "pkg-a": { "common.proto": "...", "sub/nested.proto": "..." } }
function makePackagesDir(packages) {
  const dir = mkdtempSync(join(tmpdir(), "penguin-grpc-"));
  const deps = Object.fromEntries(Object.keys(packages).map((name) => [name, "1.0.0"]));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(GRPC_MODULES, join(dir, "node_modules", "@grpc"), "dir");
  for (const [name, protos] of Object.entries(packages)) {
    for (const [rel, content] of Object.entries(protos)) {
      const file = join(dir, "node_modules", name, "dist", "protos", rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  return dir;
}

// Runs the real sidecar script in a child node process against a fixture
// packagesDir. Nothing listens on port 1, so a successful proto load ends in
// gRPC UNAVAILABLE (14) — anything else is a resolution/loading failure.
function runSidecar(packagesDir, servicePath) {
  const script = buildGrpcNativeScript({
    url: "http://127.0.0.1:1",
    servicePath,
    body: "{}",
    metadata: [],
    packagesDir,
  });
  const file = join(packagesDir, "sidecar.cjs");
  writeFileSync(file, script);
  const proc = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 30_000 });
  assert.equal(proc.status, 0, `sidecar crashed: ${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

// Mirrors the real-world bug: auth-grpc's frontend-auth.proto imports
// common.proto, but admin-grpc (sorted first) also ships a common.proto
// without the referenced enum, so global includeDirs shadow the right file.
function shadowedFixture() {
  return makePackagesDir({
    "admin-grpc": {
      "common.proto": `syntax = "proto3";\npackage common;\nmessage Empty {}\n`,
      "admin.proto": `syntax = "proto3";\npackage admin;\nimport "common.proto";\nservice AdminService { rpc Ping (common.Empty) returns (common.Empty); }\n`,
    },
    "auth-grpc": {
      "common.proto": `syntax = "proto3";\npackage common;\nenum RgLifecycleStatus { RG_UNKNOWN = 0; RG_ACTIVE = 1; }\n`,
      "sub/nested.proto": `syntax = "proto3";\npackage nested;\nmessage Extra { string note = 1; }\n`,
      "frontend-auth.proto": `syntax = "proto3";\npackage testauth;\nimport "common.proto";\nimport "nested.proto";\nmessage LoginRequest { string phone = 1; }\nmessage LoginReply { common.RgLifecycleStatus status = 1; nested.Extra extra = 2; }\nservice AuthService { rpc Login (LoginRequest) returns (LoginReply); }\n`,
    },
  });
}

test("shadowed cross-package import resolves package-locally, not as Service not found", skipOpts, () => {
  const out = runSidecar(shadowedFixture(), "/testauth.AuthService/Login");
  assert.ok(
    !/Service not found/.test(out.error ?? ""),
    `proto import shadowing must not surface as Service not found, got: ${out.error}`,
  );
  assert.equal(out.statusCode, 14, "call must reach the (dead) server and fail UNAVAILABLE");
});

test("sibling packages still resolve after narrowing includeDirs", skipOpts, () => {
  const out = runSidecar(shadowedFixture(), "/admin.AdminService/Ping");
  assert.ok(!/Service not found/.test(out.error ?? ""), `got: ${out.error}`);
  assert.equal(out.statusCode, 14);
});

test("proto load failure surfaces the loader error instead of a bare Service not found", skipOpts, () => {
  const dir = makePackagesDir({
    "broken-grpc": {
      "common.proto": `syntax = "proto3";\npackage common;\nmessage Empty {}\n`,
      "broken.proto": `syntax = "proto3";\npackage broken;\nimport "common.proto";\nmessage State { common.MissingEnum status = 1; }\nservice BrokenService { rpc Check (State) returns (State); }\n`,
    },
  });
  const out = runSidecar(dir, "/broken.BrokenService/Check");
  assert.match(out.error ?? "", /Service not found: broken\.BrokenService/);
  assert.match(out.error ?? "", /proto load failed:/, "underlying loader error must not be swallowed");
  assert.match(out.error ?? "", /MissingEnum/, "message must carry the actual proto-loader failure");
});

test("clean load with a genuinely missing service stays a plain Service not found", skipOpts, () => {
  const out = runSidecar(shadowedFixture(), "/testauth.NoSuchService/Login");
  assert.match(out.error ?? "", /Service not found: testauth\.NoSuchService/);
  assert.ok(
    !/proto load failed/.test(out.error ?? ""),
    "no load error occurred, so the message must not claim one",
  );
});
