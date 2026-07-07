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
const {
  buildPackageSpec,
  completePackageSpec,
  filterPackageRows,
  filterPackages,
  isPackageRowInstalled,
  protocolOfPackage,
} = core;

const PKGS = [
  { name: "@snsoft/auth-grpc-web", latest_version: "2.1.1-20260624172317", newest_version: "2.1.1-20260624172317", description: "auth service stubs", tags: ["cicd-master"] },
  { name: "@snsoft/auth-grpc", latest_version: "2.1.1-20260624172317", newest_version: "2.1.1-20260624172317", description: null, tags: ["master"] },
  { name: "@snsoft/payment-grpc-web", latest_version: "1.0.0-20260101000000", newest_version: "1.0.0-20260101000000", description: "payment flows", tags: ["kyc-merge-account"] },
  { name: "@snsoft/payment-grpc", latest_version: "1.0.0-20260101000000", newest_version: "1.0.0-20260101000000", description: null, tags: ["kyc-merge-account"] },
  { name: "@snsoft/promotion-grpc", latest_version: "2.0.0", newest_version: "2.0.0", description: null, tags: ["freespin-every-day-v3"] },
  { name: "@snsoft/js-sdk", latest_version: "3.0.0", newest_version: "3.0.0", description: "browser sdk", tags: [] },
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

test("browse ordering understands both stamp formats (14-digit and ISO)", () => {
  const mixed = [
    { name: "@snsoft/old-iso-grpc", latest_version: "1.0.0", newest_version: "1.0.0-2025-11-25T08-08-26-612Z", description: null, tags: [] },
    { name: "@snsoft/new-14-grpc", latest_version: "1.0.0", newest_version: "1.0.0-20260707114517", description: null, tags: [] },
    { name: "@snsoft/new-iso-grpc", latest_version: "1.0.0", newest_version: "1.0.0-2026-01-05T10-00-00-000Z", description: null, tags: [] },
  ];
  const hits = filterPackages(mixed, "", null).map((p) => p.name);
  assert.deepEqual(hits, [
    "@snsoft/new-14-grpc",
    "@snsoft/new-iso-grpc",
    "@snsoft/old-iso-grpc",
  ]);
});

test("empty query returns protocol-scoped list, capped at 50", () => {
  const big = Array.from({ length: 60 }, (_, i) => ({
    name: `@snsoft/pkg-${i}-grpc`,
    latest_version: "1.0.0",
    newest_version: "1.0.0",
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

test("filterPackageRows annotates published branch without grouping package types", () => {
  const rows = filterPackageRows(
    [
      { name: "@snsoft/player-grpc-web", latest_version: "3.1.0", newest_version: "3.2.0-20260707121048", description: null, tags: ["new-zealand", "master"], dist_tags: { "new-zealand": "3.2.0-20260707121048", master: "3.1.0-20260706101010", latest: "3.1.0" } },
      { name: "@snsoft/player-grpc", latest_version: "3.0.0", newest_version: "3.2.0-20260707121047", description: null, tags: ["flow"], dist_tags: { flow: "3.2.0-20260707121047", latest: "3.0.0" } },
      { name: "@snsoft/admin-grpc", latest_version: "1.0.30", newest_version: "1.0.30-20260706115118", description: null, tags: ["develop"] },
      { name: "@snsoft/auth-grpc", latest_version: "2.0.0", newest_version: "2.0.0-20260706115118", description: null, tags: ["master"] },
      { name: "@snsoft/js-sdk", latest_version: "1.0.0-2026-07-07T01-29-43-799Z", newest_version: "1.0.0-2026-07-07T01-29-43-799Z", description: "sdk", tags: [] },
      { name: "@snsoft/player-coco-grpc", latest_version: "1.0.0-20241021175727", newest_version: "1.0.0-20241021175727", description: null, tags: ["master"] },
      { name: "@snsoft/player-grpc-json", latest_version: "1.0.32", newest_version: "1.0.32-20260707115122", description: null, tags: ["master"] },
    ],
    { query: "player", protocol: "all" },
  );

  assert.deepEqual(
    rows.map((row) => [row.name, row.protocol, row.branch, row.version]),
    [
      ["@snsoft/player-grpc-web", "grpc-web", "new-zealand", "3.2.0-20260707121048"],
      ["@snsoft/player-grpc", "grpc", "flow", "3.2.0-20260707121047"],
      ["@snsoft/player-grpc-web", "grpc-web", "master", "3.1.0-20260706101010"],
    ],
  );
});

test("filterPackageRows supports fuzzy branch plus package searches in either order", () => {
  const list = [
    { name: "@snsoft/player-grpc-web", latest_version: "3.1.0", newest_version: "3.2.0-20260707121048", description: null, tags: ["new-zealand", "master"], dist_tags: { "new-zealand": "3.2.0-20260707121048", master: "3.1.0-20260706101010", latest: "3.1.0" } },
    { name: "@snsoft/player-grpc", latest_version: "3.1.0", newest_version: "3.2.0-20260707121047", description: null, tags: ["new-zealand", "master"], dist_tags: { "new-zealand": "3.2.0-20260707121047", master: "3.1.0-20260706101009", latest: "3.1.0" } },
    { name: "@snsoft/player-admin-grpc", latest_version: "1.0.30", newest_version: "1.0.30-20260706115118", description: null, tags: ["new-zealand"], dist_tags: { "new-zealand": "1.0.30-20260706115118" } },
    { name: "@snsoft/auth-grpc", latest_version: "2.0.0", newest_version: "2.0.0-20260706115118", description: null, tags: ["master"] },
  ];

  for (const query of ["masterplayer", "playermaster", "master player", "plyrmaster"]) {
    const rows = filterPackageRows(list, { query, protocol: "all" });

    assert.deepEqual(
      rows.map((row) => [row.name, row.protocol, row.branch, row.version]),
      [
        ["@snsoft/player-grpc-web", "grpc-web", "master", "3.1.0-20260706101010"],
        ["@snsoft/player-grpc", "grpc", "master", "3.1.0-20260706101009"],
      ],
      query,
    );
  }
});

test("filterPackageRows returns only the selected package type", () => {
  const rows = filterPackageRows(
    [
      { name: "@snsoft/player-grpc-web", latest_version: "1.0.32", newest_version: "1.0.32-20260707115119", description: null, tags: ["master"] },
      { name: "@snsoft/player-grpc", latest_version: "1.0.32", newest_version: "1.0.32-20260707115118", description: null, tags: ["master"] },
    ],
    { query: "", protocol: "grpc-web" },
  );

  assert.deepEqual(rows.map((row) => row.name), ["@snsoft/player-grpc-web"]);
});

test("filterPackageRows does not show branch for js-sdk", () => {
  const rows = filterPackageRows(
    [
      { name: "@snsoft/js-sdk", latest_version: "1.0.0-2026-07-07T01-29-43-799Z", newest_version: "1.0.0-2026-07-07T01-29-43-799Z", description: "sdk", tags: [], versions: ["1.0.0-2026-07-07T01-29-43-799Z"], dist_tags: { latest: "1.0.0-2026-07-07T01-29-43-799Z" } },
      { name: "@snsoft/player-grpc", latest_version: "1.0.32", newest_version: "1.0.32-20260707115118", description: null, tags: ["master"] },
    ],
    { query: "", protocol: "sdk" },
  );

  assert.deepEqual(
    rows.map((row) => [row.name, row.protocol, row.branch, row.version]),
    [["@snsoft/js-sdk", "sdk", "", "1.0.0-2026-07-07T01-29-43-799Z"]],
  );
});

test("filterPackageRows expands js-sdk versions as separate installable rows", () => {
  const rows = filterPackageRows(
    [
      {
        name: "@snsoft/js-sdk",
        latest_version: "1.0.0-2026-07-07T01-29-43-799Z",
        newest_version: "1.0.0-2026-07-07T02-00-00-000Z",
        description: "sdk",
        tags: [],
        versions: [
          "1.0.0-2026-07-07T01-29-43-799Z",
          "1.0.0-2026-07-07T02-00-00-000Z",
          "1.0.0-2026-07-06T23-59-59-000Z",
        ],
        dist_tags: { latest: "1.0.0-2026-07-07T01-29-43-799Z" },
      },
    ],
    { query: "", protocol: "sdk" },
  );

  assert.deepEqual(
    rows.map((row) => [row.name, row.branch, row.version, row.install_tag]),
    [
      ["@snsoft/js-sdk", "", "1.0.0-2026-07-07T02-00-00-000Z", "1.0.0-2026-07-07T02-00-00-000Z"],
      ["@snsoft/js-sdk", "", "1.0.0-2026-07-07T01-29-43-799Z", "1.0.0-2026-07-07T01-29-43-799Z"],
      ["@snsoft/js-sdk", "", "1.0.0-2026-07-06T23-59-59-000Z", "1.0.0-2026-07-06T23-59-59-000Z"],
    ],
  );
});

test("filterPackageRows hides unresolved streaming placeholders", () => {
  const rows = filterPackageRows(
    [
      { name: "@snsoft/admin-grpc", latest_version: "...", newest_version: "...", description: null, tags: [] },
      { name: "@snsoft/admin-grpc-web", latest_version: "...", newest_version: "...", description: null, tags: [] },
      { name: "@snsoft/player-grpc", latest_version: "3.2.0", newest_version: "3.2.0-20260707121047", description: null, tags: ["new-zealand"], dist_tags: { "new-zealand": "3.2.0-20260707121047" } },
    ],
    { query: "", protocol: "all" },
  );

  assert.deepEqual(rows.map((row) => row.name), ["@snsoft/player-grpc"]);
});

test("isPackageRowInstalled matches package name and resolved version", () => {
  const [row] = filterPackageRows(
    [
      { name: "@snsoft/player-grpc-web", latest_version: "3.1.0", newest_version: "3.2.0-20260707121048", description: null, tags: ["new-zealand"], dist_tags: { "new-zealand": "3.2.0-20260707121048" } },
    ],
    { query: "player", protocol: "grpc-web" },
  );

  assert.equal(
    isPackageRowInstalled(row, [{ name: "@snsoft/player-grpc-web", version: "3.1.0" }]),
    false,
  );
  assert.equal(
    isPackageRowInstalled(row, [{ name: "@snsoft/player-grpc-web", version: "3.2.0-20260707121048" }]),
    true,
  );
});

test("buildPackageSpec appends branch or defaults to latest", () => {
  assert.equal(
    buildPackageSpec("@snsoft/player-grpc-web", "master"),
    "@snsoft/player-grpc-web@master",
  );
  assert.equal(
    buildPackageSpec("@snsoft/player-grpc", ""),
    "@snsoft/player-grpc@latest",
  );
});

test("completePackageSpec keeps versioned specs and defaults bare names to latest", () => {
  assert.equal(
    completePackageSpec("@snsoft/player-grpc-web@1.0.0"),
    "@snsoft/player-grpc-web@1.0.0",
  );
  assert.equal(
    completePackageSpec("@snsoft/player-grpc-web"),
    "@snsoft/player-grpc-web@latest",
  );
});

const BRANCH_LIST = [
  { name: "@snsoft/player-grpc-web", latest_version: "3.2.0", newest_version: "3.2.0-20260707125835", description: null, tags: ["brazil-v2", "master"], dist_tags: { "brazil-v2": "3.2.0-20260707125835", master: "3.1.0-20260706101010" } },
  { name: "@snsoft/player-grpc", latest_version: "3.2.0", newest_version: "3.2.0-20260707125833", description: null, tags: ["brazil-v2"], dist_tags: { "brazil-v2": "3.2.0-20260707125833" } },
  { name: "@snsoft/ccms-grpc-web", latest_version: "2.0.2", newest_version: "2.0.2-20260707154342", description: null, tags: ["quick-action-guide"], dist_tags: { "quick-action-guide": "2.0.2-20260707154342" } },
  { name: "@snsoft/ccms-grpc", latest_version: "2.0.2", newest_version: "2.0.2-20260707154341", description: null, tags: ["quick-action-guide"], dist_tags: { "quick-action-guide": "2.0.2-20260707154341" } },
  { name: "@snsoft/js-sdk", latest_version: "1.0.0", newest_version: "1.0.0-2026-07-07T01-29-43-799Z", description: "sdk", tags: [], versions: ["1.0.0-2026-07-07T01-29-43-799Z"] },
];

test("branch filter: 'brazil' returns only brazil-v2 rows across package types", () => {
  const rows = filterPackageRows(BRANCH_LIST, { query: "", branch: "brazil", protocol: "all" });
  assert.deepEqual(
    rows.map((r) => [r.name, r.branch]),
    [
      ["@snsoft/player-grpc-web", "brazil-v2"],
      ["@snsoft/player-grpc", "brazil-v2"],
    ],
  );
});

test("branch filter: 'quick' returns only quick-action-guide rows", () => {
  const rows = filterPackageRows(BRANCH_LIST, { query: "", branch: "quick", protocol: "all" });
  assert.deepEqual(
    rows.map((r) => [r.name, r.branch]),
    [
      ["@snsoft/ccms-grpc-web", "quick-action-guide"],
      ["@snsoft/ccms-grpc", "quick-action-guide"],
    ],
  );
});

test("branch filter combines with name query and type filter (AND)", () => {
  const byName = filterPackageRows(BRANCH_LIST, { query: "player", branch: "brazil", protocol: "all" });
  assert.deepEqual(byName.map((r) => r.name), ["@snsoft/player-grpc-web", "@snsoft/player-grpc"]);

  const byType = filterPackageRows(BRANCH_LIST, { query: "", branch: "brazil", protocol: "grpc-web" });
  assert.deepEqual(byType.map((r) => r.name), ["@snsoft/player-grpc-web"]);
});

test("branch filter excludes js-sdk (no branch)", () => {
  const rows = filterPackageRows(BRANCH_LIST, { query: "", branch: "master", protocol: "all" });
  assert.ok(!rows.some((r) => r.name === "@snsoft/js-sdk"));
  assert.deepEqual(rows.map((r) => [r.name, r.branch]), [["@snsoft/player-grpc-web", "master"]]);
});

test("branch filter is prefix-only (excludes substring) and orders newest first", () => {
  const list = [
    { name: "@snsoft/a-grpc", latest_version: "1.0.0", newest_version: "1.0.0-20260706111355", description: null, tags: ["origin-edmond-replace-pulsar-with-temporal"], dist_tags: { "origin-edmond-replace-pulsar-with-temporal": "1.0.0-20260706111355" } },
    { name: "@snsoft/b-grpc", latest_version: "1.0.0", newest_version: "1.0.0-20260706111324", description: null, tags: ["replace-pulsar-with-temporal"], dist_tags: { "replace-pulsar-with-temporal": "1.0.0-20260706111324" } },
    { name: "@snsoft/c-grpc", latest_version: "1.0.0", newest_version: "1.0.0-20260706111323", description: null, tags: ["replace-pulsar-with-temporal-hotfix"], dist_tags: { "replace-pulsar-with-temporal-hotfix": "1.0.0-20260706111323" } },
  ];
  const rows = filterPackageRows(list, { query: "", branch: "replace-pulsar-with-temporal", protocol: "all" });
  // origin-edmond-... 只是包含关键字、不以它开头 → 排除
  assert.ok(!rows.some((r) => r.name === "@snsoft/a-grpc"));
  // 前缀命中保留（exact 与 exact-hotfix），且按构建时间新→旧
  assert.deepEqual(rows.map((r) => r.name), ["@snsoft/b-grpc", "@snsoft/c-grpc"]);
});

test("branch filter still supports partial typing via prefix (mast → master)", () => {
  const list = [
    { name: "@snsoft/x-grpc", latest_version: "1.0.0", newest_version: "1.0.0-20260101000000", description: null, tags: ["master"], dist_tags: { master: "1.0.0-20260101000000" } },
  ];
  assert.equal(filterPackageRows(list, { query: "", branch: "mast", protocol: "all" }).length, 1);
});

test("suggestPackageStems extracts unique family prefixes, prefix-ranked", () => {
  const { suggestPackageStems } = core;
  const list = [
    { name: "@snsoft/player-grpc-web", latest_version: "1", newest_version: "1", description: null, tags: [] },
    { name: "@snsoft/player-grpc", latest_version: "1", newest_version: "1", description: null, tags: [] },
    { name: "@snsoft/player-grpc-json", latest_version: "1", newest_version: "1", description: null, tags: [] },
    { name: "@snsoft/payment-grpc", latest_version: "1", newest_version: "1", description: null, tags: [] },
    { name: "@snsoft/js-sdk", latest_version: "1", newest_version: "1", description: null, tags: [] },
  ];
  // 空 query：去重的家族前缀，字典序
  assert.deepEqual(suggestPackageStems(list, ""), ["js-sdk", "payment", "player"]);
  // 输入 "play"：前缀命中
  assert.deepEqual(suggestPackageStems(list, "play"), ["player"]);
  // 前缀命中排在子串命中之前
  const list2 = [
    { name: "@snsoft/xplayer-grpc", latest_version: "1", newest_version: "1", description: null, tags: [] },
    { name: "@snsoft/player-grpc", latest_version: "1", newest_version: "1", description: null, tags: [] },
  ];
  assert.deepEqual(suggestPackageStems(list2, "play"), ["player", "xplayer"]);
});
