import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadRegistrySearch(hooks) {
  const source = await readFile(
    new URL("../src/lib/registry-search.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const patched = outputText
    .replace(
      'import { invoke } from "@tauri-apps/api/core";',
      "const { invoke } = globalThis.__registrySearchTest;",
    )
    .replace(
      'import { listen } from "@tauri-apps/api/event";',
      "const { listen } = globalThis.__registrySearchTest;",
    );
  const tmpUrl = new URL(
    `./.tmp-registry-search-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`,
    import.meta.url,
  );
  globalThis.__registrySearchTest = hooks;
  await writeFile(tmpUrl, patched);
  try {
    return await import(tmpUrl.href);
  } finally {
    delete globalThis.__registrySearchTest;
    await unlink(tmpUrl);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pkg(name, version) {
  return {
    name,
    latest_version: version,
    newest_version: version,
    description: null,
    tags: ["master"],
    versions: [version],
    dist_tags: { master: version },
  };
}

test("streamed enriched packages warm the cache while registry fetch is inflight", async () => {
  const cached = pkg("@snsoft/auth-grpc-web", "1.0.0-20260101000000");
  const streamed = pkg("@snsoft/player-grpc-web", "2.0.0-20260707120000");
  const finalList = [
    streamed,
    pkg("@snsoft/payment-grpc-web", "2.0.0-20260707115959"),
  ];
  const inflightRegistry = deferred();
  const listeners = new Map();
  const diskWrites = [];

  const registry = await loadRegistrySearch({
    invoke(command, args) {
      if (command === "db_get_app_value") {
        return Promise.resolve(JSON.stringify({ list: [cached] }));
      }
      if (command === "db_set_app_value") {
        diskWrites.push(args);
        return Promise.resolve(null);
      }
      if (command === "registry_search_packages") {
        return inflightRegistry.promise;
      }
      throw new Error(`unexpected command: ${command}`);
    },
    listen(event, handler) {
      listeners.set(event, handler);
      return Promise.resolve(() => listeners.delete(event));
    },
  });

  await Promise.resolve();
  const fetchPromise = registry.fetchRegistryPackages();
  listeners.get("registry-search:enriched")?.({ payload: [streamed] });

  const warmCache = await registry.loadCachedRegistryPackages();
  assert.deepEqual(
    warmCache.map((item) => item.name),
    ["@snsoft/auth-grpc-web", "@snsoft/player-grpc-web"],
  );
  assert.equal(diskWrites.length, 0, "partial streaming data must not be persisted");

  inflightRegistry.resolve(finalList);
  assert.deepEqual(await fetchPromise, finalList);

  const completeCache = await registry.loadCachedRegistryPackages();
  assert.deepEqual(
    completeCache.map((item) => item.name),
    ["@snsoft/player-grpc-web", "@snsoft/payment-grpc-web"],
  );
  assert.equal(diskWrites.length, 1, "only the complete network list is persisted");
});
