import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function load() {
  const source = await readFile(new URL("../packages/mcp/src/mcp-input-validation.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { serviceNameMatches, validateCompareEnvironmentNames, serviceCallability } = await load();

test("service short and full names match case-insensitively", () => {
  const service = { name: "BackendService", fullName: "example.backend.BackendService" };
  assert.equal(serviceNameMatches(service, "backendservice"), true);
  assert.equal(serviceNameMatches(service, "EXAMPLE.BACKEND.BACKENDSERVICE"), true);
  assert.equal(serviceNameMatches(service, "OtherService"), false);
});

test("compare environments requires at least two names", () => {
  assert.throws(() => validateCompareEnvironmentNames(["QAT"]), /at least two/i);
  assert.doesNotThrow(() => validateCompareEnvironmentNames(["QAT", "UAT"]));
});

test("health service is visible but explicitly not gateway-routable", () => {
  assert.deepEqual(serviceCallability("grpc.health.v1.Health"), {
    routable: false,
    reason: "gateway does not route grpc.health.v1.Health",
  });
  assert.deepEqual(serviceCallability("promotion.v2.FrontendService"), { routable: true });
});
