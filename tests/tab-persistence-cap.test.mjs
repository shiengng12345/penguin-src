import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Guard: persisted tab state must never carry multi-MB response bodies — one
// 7.8MB cached response inside penguin-tabs made every reader of that app_kv
// row pathologically slow. Full responses live in request_history; the tab
// copy is a capped preview.

async function loadHelpers() {
  const source = await readFile(
    new URL("../src/lib/store-persistence-helpers.ts", import.meta.url),
    "utf8",
  );
  const testSource = source
    .replace(
      /import \{[\s\S]*?\} from "\.\/app-persistence";/,
      "const deletePersistedValue = () => {}; const getPersistedValue = () => null; const setPersistedValue = () => {};",
    )
    .replace(
      /import \{ APP_VALUE_KEYS \} from "\.\/persistence-keys";/,
      "const APP_VALUE_KEYS = new Proxy({}, { get: (_t, p) => `penguin-${String(p)}` });",
    )
    .replace(
      /import \{ isAppTheme, type AppTheme \} from "\.\/theme";/,
      "const isAppTheme = () => true;",
    )
    .replace(/import type \{[\s\S]*?\} from "\.\/store-types";/, "");
  const { outputText } = ts.transpileModule(testSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const tab = (body) => ({
  id: "tab_1",
  protocolTab: "grpc-web",
  targetUrl: "{{URL}}",
  response: body === undefined ? null : { status: "OK", statusCode: 200, body, headers: {}, duration: 1 },
});

test("small response bodies persist untouched", async () => {
  const { tabsForPersistence, PERSISTED_RESPONSE_BODY_LIMIT } = await loadHelpers();
  const small = tab("y".repeat(1000));
  const [out] = tabsForPersistence([small]);
  assert.equal(out, small, "small tabs pass through by reference");
  assert.ok(PERSISTED_RESPONSE_BODY_LIMIT >= 64 * 1024);
});

test("oversized response bodies truncate to a clean slice + structured flag", async () => {
  const { tabsForPersistence, PERSISTED_RESPONSE_BODY_LIMIT } = await loadHelpers();
  const bigBody = "z".repeat(PERSISTED_RESPONSE_BODY_LIMIT * 8);
  const [out] = tabsForPersistence([tab(bigBody)]);
  // Clean prefix slice — NO prose marker inside the body (a marker silently
  // corrupts anything copied/re-sent from the restored tab).
  assert.equal(out.response.body, bigBody.slice(0, PERSISTED_RESPONSE_BODY_LIMIT));
  assert.equal(out.response.bodyTruncated, true);
  // The rest of the response stays intact.
  assert.equal(out.response.statusCode, 200);
});

test("small responses never carry the truncation flag", async () => {
  const { tabsForPersistence } = await loadHelpers();
  const [out] = tabsForPersistence([tab("tiny")]);
  assert.equal(out.response.bodyTruncated, undefined);
});

test("tabs without responses are untouched", async () => {
  const { tabsForPersistence } = await loadHelpers();
  const bare = tab(undefined);
  const [out] = tabsForPersistence([bare]);
  assert.equal(out, bare);
});
