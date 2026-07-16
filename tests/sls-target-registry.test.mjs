import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSlsConsoleUrl,
  dedupeUrls,
  mergeSlsTargets,
  resolveSlsTargets,
  INITIAL_SLS_TARGETS,
} from "../packages/mcp/dist/sls-target-registry.js";

const fpmsUat = "https://sls.console.alibabacloud.com/lognext/project/platform-uat-aliyun-logs/logsearch/platform-fpms-uat?spm=abc";
const fpmsUatWithRegion = `${fpmsUat}&slsRegion=ap-southeast-1`;
const fpmsProd = "https://sls.console.alibabacloud.com/lognext/project/platform-prod-aliyun-logs/logsearch/platform-fpms-prod?spm=abc&slsRegion=ap-southeast-1";
const brazil = "https://sls.console.alibabacloud.com/lognext/project/platform-test-brazil/logsearch/brazil-uat?slsRegion=us-west-1";
const brazilV2 = "https://sls.console.alibabacloud.com/lognext/project/platform-test-brazil/logsearch/brazil-uat-v2?slsRegion=us-west-1";
const newport = "https://sls.console.alibabacloud.com/lognext/project/platform-uat-aliyun-logs/logsearch/platform-newport-uat?slsRegion=ap-southeast-1";

test("parses supplied SLS URLs and ignores tracking parameters", () => {
  assert.equal(parseSlsConsoleUrl(fpmsProd).regionId, "ap-southeast-1");
  assert.equal(parseSlsConsoleUrl(brazilV2).project, "platform-test-brazil");
  assert.equal(parseSlsConsoleUrl(newport).logstore, "platform-newport-uat");
  assert.equal(dedupeUrls([fpmsUat, fpmsUatWithRegion]).length, 1);
  assert.equal(parseSlsConsoleUrl(fpmsUat, INITIAL_SLS_TARGETS).targetId, "fpms-uat");
});

test("requires a verified region for a URL without slsRegion", () => {
  const unknown = "https://sls.console.alibabacloud.com/lognext/project/unknown-project/logsearch/unknown-store";
  assert.equal(parseSlsConsoleUrl(unknown, INITIAL_SLS_TARGETS).status, "missing_region");
  assert.equal(parseSlsConsoleUrl("https://example.com/lognext/project/p/logsearch/l?slsRegion=cn", INITIAL_SLS_TARGETS).status, "unsupported_host");
  assert.equal(parseSlsConsoleUrl("not a url", INITIAL_SLS_TARGETS).status, "malformed");
});

test("merges aliases, rejects conflicting identities, and resolves target scopes", () => {
  const merged = mergeSlsTargets(INITIAL_SLS_TARGETS, [
    { targetId: "uat-alias", environment: "uat", aliases: ["my-uat"], regionId: "ap-southeast-1", project: "platform-uat-aliyun-logs", logstore: "platform-fpms-uat", enabled: true },
    { targetId: "disabled", environment: "test", regionId: "ap-southeast-1", project: "p", logstore: "l", enabled: false },
  ]);
  assert.ok(merged.find((target) => target.targetId === "fpms-uat")?.aliases.includes("uat-alias"));
  assert.equal(merged.find((target) => target.targetId === "disabled").enabled, false);
  assert.throws(() => mergeSlsTargets([], [
    { targetId: "a", environment: "uat", regionId: "r", project: "p", logstore: "l" },
    { targetId: "b", environment: "uat", regionId: "r", project: "p", logstore: "l" },
  ]), /conflict|duplicate/i);
  assert.deepEqual(resolveSlsTargets({ request: { scope: "targets", targetIds: ["fpms-prod"] }, registry: merged }).targets.map((target) => target.targetId), ["fpms-prod"]);
});
