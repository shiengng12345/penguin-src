import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadServicePathModule() {
  const source = await readFile(new URL("../packages/core/src/service-path.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

// Regression: proto packages with uppercase names (e.g. `package CMS;` from
// @snsoft/CMS-grpc-web) must keep their original case in the gRPC service
// segment — the wire path is case-sensitive — while the gateway route prefix
// is always lowercase. `/CMS/CMS.Svc/M` 404s at the gateway and
// `/cms/cms.Svc/M` gets UNIMPLEMENTED from the server; only `/cms/CMS.Svc/M`
// routes end to end.
test("uppercase proto package: lowercase prefix, original-case service name", async () => {
  const { computeServicePath } = await loadServicePathModule();
  assert.equal(
    computeServicePath("CMS.FrontendService.GetPageResource"),
    "/cms/CMS.FrontendService/GetPageResource",
  );
});

test("lowercase proto package is unchanged", async () => {
  const { computeServicePath } = await loadServicePathModule();
  assert.equal(
    computeServicePath("player.PlayerService.GetPlayerInfo"),
    "/player/player.PlayerService/GetPlayerInfo",
  );
});

test("nested proto package keeps inner segments' case", async () => {
  const { computeServicePath } = await loadServicePathModule();
  assert.equal(
    computeServicePath("CMS.Internal.AdminService.ListPages"),
    "/cms/CMS.Internal.AdminService/ListPages",
  );
});
