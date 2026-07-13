// tests/knowledge-indexer-package-detect.test.mjs
// Real bug repro: the flyover proto monorepo publishes FOUR package variants
// per module — @snsoft/<module>-grpc, -grpc-json, -grpc-web, -grpc-web-coco
// (confirmed on disk: fly/apps/auth/{output-grpc,output-grpc-json,
// output-grpc-web,output-grpc-web-coco}/package.json) — but
// flyoverPackageNames() only ever generated the bare "-grpc" name. Any repo
// depending on the "-web"/"-json"/"-web-coco" variants (e.g. FPMS-CCMS on
// @snsoft/auth-grpc-web) got a permanently unresolved (repoId=null) package
// node, since nothing ever registered flyover as that name's provider —
// making the consuming repo look falsely isolated in the service map.
import assert from "node:assert/strict";
import { test } from "node:test";
import { flyoverPackageNames } from "../packages/knowledge-indexer/dist/index.js";

test("flyoverPackageNames generates all four published variants per proto module", () => {
  const names = flyoverPackageNames(["auth", "player"]);
  for (const mod of ["auth", "player"]) {
    for (const suffix of ["grpc", "grpc-json", "grpc-web", "grpc-web-coco"]) {
      assert.ok(
        names.includes(`@snsoft/${mod}-${suffix}`),
        `missing @snsoft/${mod}-${suffix}`,
      );
    }
  }
});

test("flyoverPackageNames normalizes sub-path module names (e.g. ccms/internal)", () => {
  const names = flyoverPackageNames(["ccms/internal"]);
  assert.ok(names.includes("@snsoft/ccms-internal-grpc"));
  assert.ok(names.includes("@snsoft/ccms-internal-grpc-web"));
});
