import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// registry-search-core.ts imports fuse.js + @penguin/core (bare specifiers),
// so a data-URL import can't resolve them — transpile to a temp .mjs inside
// tests/ where node resolves both via the repo root node_modules.
async function loadCore() {
  const source = await readFile(
    new URL("../src/lib/registry-search-core.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const tmpUrl = new URL(
    `./.tmp-registry-search-core-${process.pid}.mjs`,
    import.meta.url,
  );
  await writeFile(tmpUrl, outputText);
  try {
    return await import(tmpUrl.href);
  } finally {
    await unlink(tmpUrl);
  }
}

const core = await loadCore();
const { filterPackages, protocolOfPackage } = core;

const PKGS = [
  { name: "@snsoft/auth-grpc-web", latest_version: "2.1.1-20260624172317", description: "auth service stubs", tags: ["cicd-master"] },
  { name: "@snsoft/auth-grpc", latest_version: "2.1.1-20260624172317", description: null, tags: ["master"] },
  { name: "@snsoft/payment-grpc-web", latest_version: "1.0.0-20260101000000", description: "payment flows", tags: ["kyc-merge-account"] },
  { name: "@snsoft/payment-grpc", latest_version: "1.0.0-20260101000000", description: null, tags: ["kyc-merge-account"] },
  { name: "@snsoft/promotion-grpc", latest_version: "2.0.0", description: null, tags: ["freespin-every-day-v3"] },
  { name: "@snsoft/js-sdk", latest_version: "3.0.0", description: "browser sdk", tags: [] },
];

test("protocol scoping: grpc-web keeps only -grpc-web packages", () => {
  const hits = filterPackages(PKGS, "", ["grpc-web"]).map((p) => p.name);
  assert.deepEqual(
    hits.sort(),
    ["@snsoft/auth-grpc-web", "@snsoft/payment-grpc-web"],
  );
});

test("protocol scoping: grpc does not swallow grpc-web", () => {
  const hits = filterPackages(PKGS, "", ["grpc"]).map((p) => p.name);
  assert.deepEqual(hits.sort(), [
    "@snsoft/auth-grpc",
    "@snsoft/payment-grpc",
    "@snsoft/promotion-grpc",
  ]);
});

test("multi-protocol toggle: grpc + sdk together", () => {
  const hits = filterPackages(PKGS, "", ["grpc", "sdk"]).map((p) => p.name);
  assert.ok(hits.includes("@snsoft/auth-grpc"));
  assert.ok(hits.includes("@snsoft/js-sdk"));
  assert.ok(!hits.includes("@snsoft/auth-grpc-web"));
});

test("project tag search finds every package carrying the tag (prefix)", () => {
  const hits = filterPackages(PKGS, "kyc-merge", null).map((p) => p.name);
  assert.ok(hits.includes("@snsoft/payment-grpc-web"));
  assert.ok(hits.includes("@snsoft/payment-grpc"));
  assert.ok(!hits.includes("@snsoft/promotion-grpc"));
});

test("tag matching is prefix-only — no leading wildcard", () => {
  const hits = filterPackages(PKGS, "master", null).map((p) => p.name);
  assert.ok(hits.includes("@snsoft/auth-grpc"), "tag 'master' should hit");
  assert.ok(
    !hits.includes("@snsoft/auth-grpc-web"),
    "tag 'cicd-master' must NOT hit query 'master'",
  );
});

test("prioritizeTags puts prefix-matching tags first", () => {
  const { prioritizeTags, tagMatchesQuery } = core;
  const tags = ["accumulative-bet-v3-1", "ai-disable-account", "kyc-merge-account"];
  assert.equal(prioritizeTags(tags, "kyc")[0], "kyc-merge-account");
  assert.ok(tagMatchesQuery("kyc-merge-account", "kyc"));
  assert.ok(tagMatchesQuery("master-dev", "mast"));
  assert.ok(!tagMatchesQuery("cicd-master", "master"));
  assert.deepEqual(prioritizeTags(tags, ""), tags);
});

test("packagesWithTag lists tagged packages per protocol", () => {
  const { packagesWithTag } = core;
  assert.deepEqual(
    packagesWithTag(PKGS, "master", "grpc").map((p) => p.name),
    ["@snsoft/auth-grpc"],
  );
  assert.deepEqual(packagesWithTag(PKGS, "master", "grpc-web"), []);
});

test("js-sdk is findable by fuzzy sdk-ish queries with no protocol filter", () => {
  for (const q of ["js-sdk", "jssdk", "sdk"]) {
    const hits = filterPackages(PKGS, q, null).map((p) => p.name);
    assert.ok(hits.includes("@snsoft/js-sdk"), `query "${q}" should find js-sdk`);
  }
});

test("fuzzy: exact-ish term ranks the right package first", () => {
  const hits = filterPackages(PKGS, "auth", ["grpc-web"]);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, "@snsoft/auth-grpc-web");
  assert.ok(!hits.some((p) => p.name.includes("payment")));
});

test("fuzzy: tolerates a typo (paymet → payment)", () => {
  const hits = filterPackages(PKGS, "paymet", null);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, "@snsoft/payment-grpc-web");
});

test("browse mode (empty query) orders newest build first", () => {
  const hits = filterPackages(PKGS, "", null).map((p) => p.name);
  // auth-* 带 2026-06-24 戳，payment-* 带 2026-01-01 戳，无戳的最后
  assert.equal(hits[0], "@snsoft/auth-grpc");
  assert.ok(
    hits.indexOf("@snsoft/auth-grpc-web") < hits.indexOf("@snsoft/payment-grpc"),
  );
  assert.ok(
    hits.indexOf("@snsoft/payment-grpc") < hits.indexOf("@snsoft/js-sdk"),
  );
});

test("empty query returns protocol-scoped list, capped at 50", () => {
  const big = Array.from({ length: 60 }, (_, i) => ({
    name: `@snsoft/pkg-${i}-grpc`,
    latest_version: "1.0.0",
    description: null,
    tags: [],
  }));
  assert.equal(filterPackages(big, "", ["grpc"]).length, 50);
  assert.equal(filterPackages(PKGS, "", null).length, PKGS.length);
});

test("protocolOfPackage detects suffixes on bare names", () => {
  assert.equal(protocolOfPackage("@snsoft/auth-grpc-web"), "grpc-web");
  assert.equal(protocolOfPackage("@snsoft/auth-grpc"), "grpc");
  assert.equal(protocolOfPackage("@snsoft/js-sdk"), "sdk");
});
