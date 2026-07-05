import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("app starts directly in request workspace without a Packages home page", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const tabBarSource = await readFile(new URL("../src/components/layout/TabBar.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(appSource, /PackagesHome/);
  assert.doesNotMatch(appSource, /homeActive/);
  assert.doesNotMatch(appSource, /onHomeClick/);
  assert.doesNotMatch(tabBarSource, /Packages/);
  assert.doesNotMatch(tabBarSource, /homeActive/);
  assert.doesNotMatch(tabBarSource, /onHomeClick/);
});

test("app always renders request chrome for the active request tab", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // Allow prop renames / reordering — what matters is UrlBar is mounted,
  // not whether it currently passes `resolvedUrl` by that exact name.
  assert.match(appSource, /<UrlBar\b[^>]*\/>/);
  // The load-bearing assertion: chrome must NOT be wrapped in
  // `activeTab ? (...)` — that was the bug where switching to an empty
  // workspace blanked the entire request panel.
  assert.doesNotMatch(appSource, /activeTab \? \(/);
  assert.match(appSource, /<RequestPanel \/>/);
  assert.match(appSource, /<ResponsePanel \/>/);
});

test("request sidebar switches horizontally between packages and collections", async () => {
  const sidebarSource = await readFile(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");

  assert.match(sidebarSource, /savedRequests/);
  assert.match(sidebarSource, /Collections/);
  assert.match(sidebarSource, /const \[sidebarView, setSidebarView\]/);
  assert.match(sidebarSource, /sidebarView === "packages"/);
  assert.match(sidebarSource, /sidebarView === "collections"/);
  assert.match(sidebarSource, /aria-pressed=\{sidebarView === "packages"\}/);
  assert.match(sidebarSource, /aria-pressed=\{sidebarView === "collections"\}/);
  assert.match(sidebarSource, /openSavedRequest/);
  assert.doesNotMatch(sidebarSource, /ChevronsDownUp/);
  assert.doesNotMatch(sidebarSource, /\{collectionsSection\}/);
});

test("request sidebar tabs use a quiet underline selected state", async () => {
  const sidebarSource = await readFile(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");

  // Active-tab style uses an underline (border-b) tinted with primary,
  // plus primary text. Looking for the tokens individually instead of
  // a packed substring tolerates Prettier/Tailwind class reordering.
  assert.match(sidebarSource, /\bborder-b-2\b/);
  assert.match(sidebarSource, /\bborder-primary\b/);
  assert.match(sidebarSource, /\btext-primary\b/);
  // The "quiet, not loud" design rule — guards against regression to
  // the prior filled-pill style. KEEP THESE TWO NEGATIVES VERBATIM.
  assert.doesNotMatch(sidebarSource, /bg-primary\/15/);
  assert.doesNotMatch(sidebarSource, /border-primary\/60 bg-primary/);
});

test("request sidebar does not duplicate method search", async () => {
  const sidebarSource = await readFile(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(sidebarSource, /Search methods\.\.\./);
  assert.doesNotMatch(sidebarSource, /searchQuery/);
  assert.doesNotMatch(sidebarSource, /filteredPackages/);
});

test("desktop persistence has SQLite commands for app state and saved requests", async () => {
  const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const dbSource = await readFile(new URL("../src-tauri/src/db.rs", import.meta.url), "utf8");
  const cargoSource = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const dbBridgeSource = await readFile(new URL("../src/lib/penguin-db.ts", import.meta.url), "utf8");

  assert.match(cargoSource, /rusqlite/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS app_kv/);
  assert.match(dbSource, /fn db_set_app_value/);
  assert.match(dbSource, /fn db_get_app_value/);
  assert.match(dbSource, /fn db_list_app_values/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS saved_requests/);
  assert.match(dbSource, /fn db_upsert_saved_request/);
  assert.match(dbSource, /fn db_list_saved_requests/);
  assert.match(libSource, /db_set_app_value,/);
  assert.match(libSource, /db_get_app_value,/);
  assert.match(libSource, /db_list_app_values,/);
  assert.match(libSource, /db_upsert_saved_request,/);
  assert.match(dbBridgeSource, /invoke\("db_set_app_value"/);
  assert.match(dbBridgeSource, /invoke<string \| null>\("db_get_app_value"/);
  assert.match(dbBridgeSource, /invoke<Record<string, string>>\("db_list_app_values"/);
  assert.match(dbBridgeSource, /invoke\("db_upsert_saved_request"/);
  assert.match(dbBridgeSource, /invoke<SavedRequest\[\]>\("db_list_saved_requests"/);
});

test("app bootstrap persists via SQLite only — no localStorage", async () => {
  // The version-cache reads/writes (getAppValueFromDatabase /
  // setAppValueInDatabase) left main.tsx together with the update-time
  // package wipe; see app-update-keeps-packages.test.mjs.
  const mainSource = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(mainSource, /localStorage/);
});

test("desktop app uses SQLite-backed persistence before rendering — App imported AFTER hydrate", async () => {
  // Invariant: render happens after hydrate AND App is dynamic-
  // imported AFTER hydrate. The "perf win" of statically importing App
  // at the top of main.tsx was reverted because it ran App's entire
  // transitive module graph (including store.ts) before the persistence
  // cache was populated — store.ts:340 reads getPersistedValue
  // (devModeEnabled) synchronously at module-eval time, so the eager
  // import locked devModeEnabled=false even when the user had a
  // valid super-admin token on disk. Symptom: "every time I reload,
  // the admin token disappears." The on-disk row was always intact;
  // only the in-memory flag was stale.
  //
  // KEEP THE DYNAMIC IMPORT. The ~100ms saved is not worth silently
  // breaking dev-mode hydration.
  const mainSource = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  const hydrateIndex = mainSource.indexOf("await hydratePersistedValues()");
  const renderIndex = mainSource.indexOf("ReactDOM.createRoot");
  const dynamicAppIndex = mainSource.indexOf("await import(\"./App\")");

  assert.ok(hydrateIndex > -1, "main should hydrate persisted SQLite values before rendering");
  assert.ok(renderIndex > hydrateIndex, "render must happen after hydrate awaits");
  // App import must be DYNAMIC (await import) and must come AFTER hydrate.
  assert.ok(dynamicAppIndex > hydrateIndex, "App must be dynamic-imported AFTER hydrate so its module graph evaluates against a populated cache");
  // No static `import App from "./App"` at the top of file — it would
  // re-introduce the dev-mode-token vanish bug.
  assert.doesNotMatch(mainSource, /^import App from "\.\/App";?$/m);
});

test("desktop product code only touches localStorage inside the legacy migration bridge", async () => {
  const root = new URL("..", import.meta.url);
  const allowed = new Set(["src/lib/app-persistence.ts"]);
  const targets = ["index.html", "src"];
  const offenders = [];

  async function visit(relativePath) {
    const url = new URL(relativePath, root);
    if (relativePath.endsWith(".html") || relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
      const source = await readFile(url, "utf8");
      // Strip single-line comments and block comments before scanning so
      // that "localStorage" appearing only in a code comment doesn't
      // falsely flag the file. The regex approach is simpler than a full
      // parser and accurate enough for this invariant check.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
        .replace(/\/\/[^\n]*/g, "");         // single-line comments
      if (!allowed.has(relativePath) && /localStorage/.test(stripped)) {
        offenders.push(relativePath);
      }
      return;
    }

    const entries = await readdir(url, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (/\.(html|ts|tsx)$/.test(entry.name)) {
        await visit(child);
      }
    }
  }

  for (const target of targets) {
    await visit(target);
  }

  assert.deepEqual(offenders, []);
});

test("restored request tabs filter out hidden REST tabs", async () => {
  // loadTabs lives in the persistence helpers extracted from store.ts.
  const storeSource = await readFile(
    new URL("../src/lib/store-persistence-helpers.ts", import.meta.url),
    "utf8",
  );
  const start = storeSource.indexOf("function loadTabs");
  const end = storeSource.indexOf("let _saveTabsTimer", start);
  const loadTabsSource = storeSource.slice(start, end);

  assert.match(loadTabsSource, /filter\(\(tab(?:: RequestTab)?\) => tab\.protocolTab !== "rest"\)/);
});

test("running app sanitizes already-open hidden REST tabs", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const storeSource = await readFile(new URL("../src/lib/store.ts", import.meta.url), "utf8");
  const storeTypesSource = await readFile(
    new URL("../src/lib/store-types.ts", import.meta.url),
    "utf8",
  );

  // The AppState action signature lives in store-types.ts; the body in store.ts.
  assert.match(storeTypesSource, /sanitizeHiddenRestTabs: \(\) => void/);
  assert.match(storeSource, /sanitizeHiddenRestTabs: \(\) => \{/);
  assert.match(appSource, /sanitizeHiddenRestTabs/);
  assert.match(appSource, /sanitizeHiddenRestTabs\(\);/);
});

test("first-run copy does not advertise legacy hidden REST-protocol mode", async () => {
  // REST is now a first-class module with its own MainSidebar icon, so
  // the ShortcutCheatSheet legitimately references it. This guard is
  // scoped to onboarding flows so first-time gRPC users aren't pointed
  // at the legacy hidden-REST-protocol tab kind (sanitizeHiddenRestTabs
  // prunes it).
  const visibleCopyFiles = [
    "../src/components/onboarding/Welcome.tsx",
    "../src/components/onboarding/Tutorial.tsx",
    "../src/components/onboarding/InteractiveTutorial.tsx",
  ];

  for (const file of visibleCopyFiles) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /REST/, file);
  }
});
