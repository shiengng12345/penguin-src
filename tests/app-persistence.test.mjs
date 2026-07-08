import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function importAppPersistenceWithMock() {
  const sourcePath = new URL("../src/lib/app-persistence.ts", import.meta.url);
  const original = await readFile(sourcePath, "utf8");
  const testSource = original
    .replace(
      /import\s*\{[\s\S]*?deleteAppValueFromDatabase[\s\S]*?loadAppValuesFromDatabase[\s\S]*?setAppValueInDatabase[\s\S]*?\}\s*from "\.\/penguin-db";/,
      `const {
        deleteAppValueFromDatabase,
        loadAppValuesFromDatabase,
        setAppValueInDatabase,
      } = globalThis.__penguinDbMock;`,
    )
    .replace(
      /import\s*\{\s*LEGACY_BROWSER_STORAGE_KEYS\s*\}\s*from "\.\/persistence-keys";/,
      "const LEGACY_BROWSER_STORAGE_KEYS = [];",
    );
  const { outputText: source } = ts.transpileModule(testSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${randomUUID()}`);
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

test("app persistence serializes same-key writes so an older REST save cannot win after delete", async () => {
  const key = "penguin-rest-requests";
  const withRequest = JSON.stringify([{ id: "req_1" }]);
  const afterDelete = JSON.stringify([]);
  const persisted = new Map();
  const writes = [];

  globalThis.__penguinDbMock = {
    loadAppValuesFromDatabase: async () => ({}),
    deleteAppValueFromDatabase: async (deleteKey) => {
      persisted.delete(deleteKey);
      return true;
    },
    setAppValueInDatabase: (writeKey, value) => {
      let resolve;
      const promise = new Promise((done) => {
        resolve = () => {
          persisted.set(writeKey, value);
          done(true);
        };
      });
      writes.push({ key: writeKey, value, resolve });
      return promise;
    },
  };

  try {
    const persistence = await importAppPersistenceWithMock();
    persistence.setPersistedValue(key, withRequest);
    persistence.setPersistedValue(key, afterDelete);
    await flushMicrotasks();

    assert.equal(
      writes.length,
      1,
      "the newer delete snapshot must wait behind the older in-flight save",
    );

    writes[0].resolve();
    await flushMicrotasks();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].value, afterDelete);

    writes[1].resolve();
    await flushMicrotasks();
    assert.equal(persisted.get(key), afterDelete);
  } finally {
    delete globalThis.__penguinDbMock;
  }
});
