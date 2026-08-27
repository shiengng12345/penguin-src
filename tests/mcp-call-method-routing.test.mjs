import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadTs(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { requireCallTarget, buildDefaultHeaders, attachRequestId } = await loadTs(
  "../packages/mcp/src/mcp-input-validation.ts",
);
// The real generator now lives in @penguin/core (mcp/src/request-id.ts is a
// re-export, unresolvable inside a data: module) — transpile the CORE source
// and pin the re-export by content so the indirection can't silently drift.
const { PENGUIN_REQUEST_ID_HEADER, generatePenguinRequestId } = await loadTs(
  "../packages/core/src/request-id.ts",
);

test("mcp request-id module re-exports the shared core implementation", async () => {
  const source = await readFile(
    new URL("../packages/mcp/src/request-id.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /export \{ PENGUIN_REQUEST_ID_HEADER, generatePenguinRequestId \} from "@penguin\/core";/,
  );
});

test("call_method requires either url or environmentName", () => {
  assert.throws(() => requireCallTarget(undefined, undefined), /requires either `url` or `environmentName`/);
  assert.doesNotThrow(() => requireCallTarget("https://example.com", undefined));
  assert.doesNotThrow(() => requireCallTarget(undefined, "QAT"));
});

test("buildDefaultHeaders maps X_ENV_TAG and TOKEN the same way resolve_environment does", () => {
  assert.deepEqual(buildDefaultHeaders({ X_ENV_TAG: "QAT", TOKEN: "abc" }), {
    "x-env-tag": "QAT",
    authorization: "Bearer abc",
  });
  assert.deepEqual(buildDefaultHeaders({ TOKEN: "Bearer already-prefixed" }), {
    authorization: "Bearer already-prefixed",
  });
  assert.deepEqual(buildDefaultHeaders({}), {});
});

test("attachRequestId always overrides any existing value under that header", () => {
  const withoutOne = attachRequestId({ "x-env-tag": "QAT" }, PENGUIN_REQUEST_ID_HEADER, "penguin-fresh");
  assert.deepEqual(withoutOne, { "x-env-tag": "QAT", "x-penguin-id": "penguin-fresh" });

  const overriding = attachRequestId(
    { [PENGUIN_REQUEST_ID_HEADER]: "penguin-manually-typed" },
    PENGUIN_REQUEST_ID_HEADER,
    "penguin-real",
  );
  assert.equal(overriding[PENGUIN_REQUEST_ID_HEADER], "penguin-real");
});

test("generatePenguinRequestId produces unique, time-ordered penguin-<uuidv7> ids", () => {
  const a = generatePenguinRequestId();
  const b = generatePenguinRequestId();
  const shape = /^penguin-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(a, shape);
  assert.match(b, shape);
  assert.notEqual(a, b);
});
