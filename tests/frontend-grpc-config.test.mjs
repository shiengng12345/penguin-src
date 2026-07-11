import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFrontendGrpcConfig } from "../packages/knowledge-indexer/dist/frontend-grpc-config.js";

test("loads config", () => {
  const dir = mkdtempSync(join(tmpdir(), "fgc-"));
  writeFileSync(join(dir, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
    wrappers: { "SkinFragment": "NtSkinFragmentService" },
  }));
  const cfg = loadFrontendGrpcConfig(dir);
  assert.equal(cfg.dispatcher, "requestApi");
  assert.equal(cfg.serviceEnumMap["NT_SERVICE_INTERFACE.SKINFRAGMENT"], "SkinFragment");
  assert.equal(cfg.wrappers["SkinFragment"], "NtSkinFragmentService");
});

test("null when absent", () => {
  assert.equal(loadFrontendGrpcConfig(mkdtempSync(join(tmpdir(), "fgc-"))), null);
});
