import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadPackageSpecModule() {
  const source = await readFile(new URL("../packages/core/src/package-spec.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("accepts only versioned snsoft grpc, grpc-web, and js-sdk specs", async () => {
  const { isAllowedSnsoftPackageSpec } = await loadPackageSpecModule();

  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/auth-grpc@1.0.0"), true);
  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/player-grpc-web@1.0.0-20260312191315"), true);
  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/js-sdk@1.0.0-2026-03-05T06-26-26-341Z"), true);

  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/auth-grpc"), false);
  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/js-sdk"), false);
  assert.equal(isAllowedSnsoftPackageSpec("@snsoft/auth-sdk@1.0.0"), false);
  assert.equal(isAllowedSnsoftPackageSpec("lodash@1.0.0"), false);
  assert.equal(isAllowedSnsoftPackageSpec("@evil/auth-grpc@1.0.0"), false);
});

test("normalizePackageSpec converts package.json / yaml lines to canonical @name@version", async () => {
  const { normalizePackageSpec, isAllowedSnsoftPackageSpec } = await loadPackageSpecModule();

  // ---- All 3 protocol types must round-trip cleanly ----
  // The normalizer doesn't care about protocol — but we lock end-to-end that
  // each form a user actually copies from package.json comes out canonical
  // AND passes isAllowedSnsoftPackageSpec (so Install button enables).

  // gRPC — numeric timestamp suffix is the common Snsoft build format.
  const grpc = normalizePackageSpec('"@snsoft/auth-grpc": "1.0.0-20260512103732"');
  assert.equal(grpc, "@snsoft/auth-grpc@1.0.0-20260512103732");
  assert.equal(isAllowedSnsoftPackageSpec(grpc), true);

  // gRPC-Web — same shape, different protocol suffix.
  const grpcWeb = normalizePackageSpec('"@snsoft/player-grpc-web": "1.0.0-20260512103732"');
  assert.equal(grpcWeb, "@snsoft/player-grpc-web@1.0.0-20260512103732");
  assert.equal(isAllowedSnsoftPackageSpec(grpcWeb), true);

  // JS-SDK — singleton (no `-grpc` suffix in the name).
  const sdk = normalizePackageSpec('"@snsoft/js-sdk": "1.0.0-20260512103732"');
  assert.equal(sdk, "@snsoft/js-sdk@1.0.0-20260512103732");
  assert.equal(isAllowedSnsoftPackageSpec(sdk), true);

  // JS-SDK with ISO-ish timestamp (older build format with embedded T).
  const sdkIso = normalizePackageSpec('"@snsoft/js-sdk": "1.0.0-2026-03-05T06-26-26-341Z"');
  assert.equal(sdkIso, "@snsoft/js-sdk@1.0.0-2026-03-05T06-26-26-341Z");
  assert.equal(isAllowedSnsoftPackageSpec(sdkIso), true);

  // ---- Surrounding format variations ----
  // Mid-list package.json with trailing comma — common when copying one row.
  assert.equal(
    normalizePackageSpec('"@snsoft/player-grpc-web": "1.0.0",'),
    "@snsoft/player-grpc-web@1.0.0",
  );
  // Leading + trailing whitespace.
  assert.equal(
    normalizePackageSpec('  "@snsoft/js-sdk": "1.0.0"   '),
    "@snsoft/js-sdk@1.0.0",
  );
  // YAML-ish (unquoted) — supports rare hand-edit cases. Works across all 3.
  assert.equal(
    normalizePackageSpec("@snsoft/auth-grpc: 1.0.0"),
    "@snsoft/auth-grpc@1.0.0",
  );
  assert.equal(
    normalizePackageSpec("@snsoft/player-grpc-web: 1.0.0"),
    "@snsoft/player-grpc-web@1.0.0",
  );
  assert.equal(
    normalizePackageSpec("@snsoft/js-sdk: 1.0.0"),
    "@snsoft/js-sdk@1.0.0",
  );

  // Already canonical — passthrough, all 3 types.
  for (const canonical of [
    "@snsoft/auth-grpc@1.0.0",
    "@snsoft/player-grpc-web@1.0.0",
    "@snsoft/js-sdk@1.0.0",
  ]) {
    assert.equal(normalizePackageSpec(canonical), canonical);
  }

  // Partial / typo / unmatched format — returned as-is so the validator
  // surfaces the real error to the user instead of mangled garbage.
  assert.equal(normalizePackageSpec(""), "");
  assert.equal(normalizePackageSpec("@snsoft/player-grpc"), "@snsoft/player-grpc");
  assert.equal(normalizePackageSpec('"unclosed'), '"unclosed');
});

test("PackageInstaller routes input through normalizePackageSpec", async () => {
  // Source-assertion: onChange must call the normalizer so paste auto-converts.
  // Reverting to `setSpec(e.target.value)` would re-introduce the bug the
  // user reported (pasting `"@snsoft/x": "1.0.0"` showed broken text).
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /import \{[^}]*normalizePackageSpec[^}]*\}/);
  // The onChange handler must pipe its input through normalizePackageSpec
  // before setting state. Loosened to tolerate parameter rename / handler
  // extraction — what we care about is that the function is in the chain.
  assert.match(source, /onChange=\{[^}]*normalizePackageSpec[^}]*\}/);
});

test("PackageInstaller package search disables browser autocomplete", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /placeholder="搜索 \/ 勾选产品线，例如：player, auth, ccms"[\s\S]*autoComplete="off"/);
  assert.match(source, /placeholder="搜索 \/ 勾选产品线，例如：player, auth, ccms"[\s\S]*spellCheck=\{false\}/);
});

test("PackageInstaller refresh streams enriched registry rows into the list", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /registry-search:enriched/);
  assert.match(source, /mergeRegistryPackages/);
  assert.match(source, /fetchRegistryPackages\(\{ force: true \}\)/);
});

test("PackageInstaller installs the selected row by exact displayed version", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /function packageInstallSpec/);
  assert.match(source, /return `\$\{pkg\.name\}@\$\{pkg\.version\}`/);
  // 多选批量安装：勾选的行按其精确显示版本生成规格
  assert.match(source, /selectedRows\.map\(packageInstallSpec\)/);
  // 旧的单选 selectedPackage / 按 tag 安装的路径已移除
  assert.doesNotMatch(source, /selectedPackage/);
  assert.doesNotMatch(source, /buildPackageSpec\([^)]*install_tag\)/);
});

test("PackageInstaller spins a loader in the install button while installing", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /isInstalling\s*\?\s*\(\s*<Loader2 className="h-4 w-4 animate-spin" \/>\s*\)\s*:\s*\(\s*<Download className="h-4 w-4" \/>\s*\)/,
  );
});

test("PackageInstaller renders compact rows with branch chip after build time", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, />Version</);
  assert.doesNotMatch(source, />Build</);
  assert.match(source, /function BranchChip/);
  assert.match(source, /GitBranch/);
  assert.match(source, /max-w-\[(?:1[4-6]0px|10rem)\]/);
  // 分支全名改为 hover 自定义 tooltip（portal），不再用原生 title={branch}
  assert.match(source, /function BranchChip[\s\S]*createPortal/);
  assert.match(source, /title=\{pkg\.version\}/);
  assert.match(source, /font-mono[\s\S]*\{pkg\.version\}/);
  // 时间列在分支列之前
  assert.match(source, /fmtStamp\(stamp\)[\s\S]*<BranchChip branch=\{pkg\.branch\}/);
  assert.match(source, /共 \{searchResults\.length\} 个结果/);
});

test("App prewarms the registry list on startup", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // 启动即后台拉一次（预热连接 + 内存缓存），失败静默
  assert.match(source, /fetchRegistryPackages\(\)\.catch\(/);
});

test("registry-search bridges streamed enriched events into memory cache", async () => {
  const source = await readFile(
    new URL("../src/lib/registry-search.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /listen<RegistryPackage\[\]>\("registry-search:enriched"/);
  assert.match(source, /mergeRegistryPackages/);
});

test("PackageInstaller auto-refresh delegates to shared poller, 5s, paused while installing", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  // 严格门控 + 安装中暂停，委托给共享自调度轮询（在途去重 + 退避），开着用 5s
  assert.match(source, /canBackgroundRefreshRegistry\(\{ enabled: autoRefresh, devModeEnabled, hasValidToken \}\)/);
  assert.match(source, /!isInstalling;/);
  assert.match(source, /useRegistryPoll\(installerPollActive, REGISTRY_AUTO_REFRESH_OPEN_MS\)/);
});

test("PackageInstaller auto-refresh is gated to admin tokens; normal users one-shot", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  // admin/super-admin = 有效 dev token；普通用户点击 = 单次强制刷新
  assert.match(source, /const canAutoRefresh = devModeEnabled && hasValidToken;/);
  // 开关持久化到 store（跨关闭/重开记住，供 app 级后台 poller 共享）
  assert.match(source, /if \(canAutoRefresh\) setInstallerAutoRefresh\(!autoRefresh\);/);
  assert.match(source, /else void loadRegistryList\(\{ useCache: false, force: true \}\);/);
  // 绿灯常转（admin 开启时）；普通用户仅加载中转
  assert.match(source, /canAutoRefresh && autoRefresh\) \|\| \(!canAutoRefresh && listLoading\)/);
});

test("PackageInstaller manual input is a highlighted card that auto-focuses on empty search", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  // 行动号召标题 + 青色左边框强调
  assert.match(source, /搜不到想要的？直接输入包名安装/);
  assert.match(source, /border-l-cyan-400\/70/);
  // 无结果标志 + 防抖自动聚焦（停 500ms 且仍无结果才聚焦，不打字途中抢焦点）
  assert.match(source, /const noSearchResults =/);
  assert.match(source, /searchResults\.length === 0/);
  assert.match(source, /setTimeout\(\(\) => manualInputRef\.current\?\.focus\(\), 500\)/);
});

test("extracts package name from allowed snsoft package specs", async () => {
  const { snsoftPackageNameFromSpec } = await loadPackageSpecModule();

  assert.equal(snsoftPackageNameFromSpec("@snsoft/auth-grpc@1.0.0"), "@snsoft/auth-grpc");
  assert.equal(
    snsoftPackageNameFromSpec("@snsoft/player-grpc-web@1.0.0-20260312191315"),
    "@snsoft/player-grpc-web",
  );
  assert.equal(
    snsoftPackageNameFromSpec("@snsoft/js-sdk@1.0.0-2026-03-05T06-26-26-341Z"),
    "@snsoft/js-sdk",
  );
  assert.equal(snsoftPackageNameFromSpec("@snsoft/auth-grpc"), null);
  assert.equal(snsoftPackageNameFromSpec("lodash@1.0.0"), null);
});
