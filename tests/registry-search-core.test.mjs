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
  { name: "@snsoft/auth-grpc-web", latest_version: "2.1.1-20260624172317", description: "auth service stubs", tags: [] },
  { name: "@snsoft/auth-grpc", latest_version: "2.1.1-20260624172317", description: null, tags: [] },
  { name: "@snsoft/payment-grpc-web", latest_version: "1.0.0-20260101000000", description: "payment flows", tags: ["kyc-merge-account"] },
  { name: "@snsoft/payment-grpc", latest_version: "1.0.0-20260101000000", description: null, tags: ["kyc-merge-account"] },
  { name: "@snsoft/promotion-grpc", latest_version: "2.0.0", description: null, tags: ["freespin-every-day-v3"] },
  { name: "@snsoft/js-sdk", latest_version: "3.0.0", description: "browser sdk", tags: [] },
];

test("protocol scoping: grpc-web keeps only -grpc-web packages", () => {
  const hits = filterPackages(PKGS, "", "grpc-web").map((p) => p.name);
  assert.deepEqual(
    hits.sort(),
    ["@snsoft/auth-grpc-web", "@snsoft/payment-grpc-web"],
  );
});

test("protocol scoping: grpc does not swallow grpc-web", () => {
  const hits = filterPackages(PKGS, "", "grpc").map((p) => p.name);
  assert.deepEqual(hits.sort(), [
    "@snsoft/auth-grpc",
    "@snsoft/payment-grpc",
    "@snsoft/promotion-grpc",
  ]);
});

test("project tag search finds every package carrying the tag", () => {
  const hits = filterPackages(PKGS, "kyc-merge-account", null).map((p) => p.name);
  assert.ok(hits.includes("@snsoft/payment-grpc-web"));
  assert.ok(hits.includes("@snsoft/payment-grpc"));
  assert.ok(!hits.includes("@snsoft/promotion-grpc"));
});

test("js-sdk is findable by fuzzy sdk-ish queries with no protocol filter", () => {
  for (const q of ["js-sdk", "jssdk", "sdk"]) {
    const hits = filterPackages(PKGS, q, null).map((p) => p.name);
    assert.ok(hits.includes("@snsoft/js-sdk"), `query "${q}" should find js-sdk`);
  }
});

test("fuzzy: exact-ish term ranks the right package first", () => {
  const hits = filterPackages(PKGS, "auth", "grpc-web");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, "@snsoft/auth-grpc-web");
  assert.ok(!hits.some((p) => p.name.includes("payment")));
});

test("fuzzy: tolerates a typo (paymet → payment)", () => {
  const hits = filterPackages(PKGS, "paymet", null);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, "@snsoft/payment-grpc-web");
});

test("empty query returns protocol-scoped list, capped at 50", () => {
  const big = Array.from({ length: 60 }, (_, i) => ({
    name: `@snsoft/pkg-${i}-grpc`,
    latest_version: "1.0.0",
    description: null,
  }));
  assert.equal(filterPackages(big, "", "grpc").length, 50);
  assert.equal(filterPackages(PKGS, "", null).length, PKGS.length);
});

test("protocolOfPackage detects suffixes on bare names", () => {
  assert.equal(protocolOfPackage("@snsoft/auth-grpc-web"), "grpc-web");
  assert.equal(protocolOfPackage("@snsoft/auth-grpc"), "grpc");
  assert.equal(protocolOfPackage("@snsoft/js-sdk"), "sdk");
});
