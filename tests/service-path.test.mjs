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

// ---- Connect protocol paths -------------------------------------------------

test("connect path: no gateway prefix, case preserved", async () => {
  const { computeConnectServicePath } = await loadServicePathModule();
  assert.equal(
    computeConnectServicePath("CMS.FrontendService.GetPageResource"),
    "/CMS.FrontendService/GetPageResource",
  );
  assert.equal(
    computeConnectServicePath("recommend.FrontendRecommendService.Search"),
    "/recommend.FrontendRecommendService/Search",
  );
});

test("connect path: nested package stays intact", async () => {
  const { computeConnectServicePath } = await loadServicePathModule();
  assert.equal(
    computeConnectServicePath("CMS.Internal.AdminService.ListPages"),
    "/CMS.Internal.AdminService/ListPages",
  );
});

test("parse: legacy 3-segment form works for both protocols", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  for (const protocol of ["grpc-web", "connect"]) {
    assert.deepEqual(parseWebRpcServicePath("/cms/CMS.FrontendService/GetPageGameListV2", protocol), {
      protoPackage: "cms",
      typeName: "CMS.FrontendService",
      methodName: "GetPageGameListV2",
    });
  }
});

test("parse: extra middle segments collapse into the type name", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  assert.deepEqual(parseWebRpcServicePath("/pkg/a/b/Method", "grpc-web"), {
    protoPackage: "pkg",
    typeName: "a.b",
    methodName: "Method",
  });
});

test("parse: connect accepts the 2-segment root-mounted form", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  assert.deepEqual(
    parseWebRpcServicePath("/player.FrontendLoginConfigService/GetFrontendLoginConfigNoAuth", "connect"),
    {
      protoPackage: null,
      typeName: "player.FrontendLoginConfigService",
      methodName: "GetFrontendLoginConfigNoAuth",
    },
  );
  // Trailing slash tolerated.
  assert.equal(
    parseWebRpcServicePath("/recommend.FrontendRecommendService/Search/", "connect").typeName,
    "recommend.FrontendRecommendService",
  );
});

test("parse: grpc-web rejects the 2-segment form", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  assert.equal(parseWebRpcServicePath("/player.FrontendLoginConfigService/GetX", "grpc-web"), null);
});

test("parse: 2-segment form requires a dotted service name", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  // A plain REST-ish path must never be mistaken for a Connect service path.
  assert.equal(parseWebRpcServicePath("/users/list", "connect"), null);
});

test("parse: too-short paths are rejected", async () => {
  const { parseWebRpcServicePath } = await loadServicePathModule();
  assert.equal(parseWebRpcServicePath("/OnlySegment", "connect"), null);
  assert.equal(parseWebRpcServicePath("/", "connect"), null);
  assert.equal(parseWebRpcServicePath("", "grpc-web"), null);
});
