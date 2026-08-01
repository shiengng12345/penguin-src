import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// tab-actions.ts is pure: its only import is `import type { RequestTab }`,
// which TS erases at transpile — so the emitted JS has no runtime deps and
// imports cleanly with no mocking.
async function loadTabActions() {
  const source = await readFile(new URL("../src/lib/tab-actions.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const tab = (id, extra = {}) => ({
  id,
  protocolTab: "grpc",
  targetUrl: "{{URL}}",
  metadata: [{ key: "authorization", value: "Bearer x", enabled: true }],
  selectedMethod: null,
  response: null,
  isLoading: false,
  origin: null,
  ...extra,
});

test("closeOtherTabs keeps only the target and makes it active", async () => {
  const { closeOtherTabs } = await loadTabActions();
  const tabs = [tab("a"), tab("b"), tab("c")];
  const r = closeOtherTabs(tabs, "b", "a");
  assert.deepEqual(r.tabs.map((t) => t.id), ["b"]);
  assert.equal(r.activeTabId, "b");
});

test("closeOtherTabs is a no-op when the id is unknown", async () => {
  const { closeOtherTabs } = await loadTabActions();
  const tabs = [tab("a"), tab("b")];
  const r = closeOtherTabs(tabs, "zzz", "a");
  assert.deepEqual(r.tabs.map((t) => t.id), ["a", "b"]);
  assert.equal(r.activeTabId, "a");
});

test("closeTabsToRight drops tabs to the right of the id", async () => {
  const { closeTabsToRight } = await loadTabActions();
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
  const r = closeTabsToRight(tabs, "b", "a");
  assert.deepEqual(r.tabs.map((t) => t.id), ["a", "b"]);
  assert.equal(r.activeTabId, "a", "active on the left is preserved");
});

test("closeTabsToRight reassigns active to the id when the active tab was dropped", async () => {
  const { closeTabsToRight } = await loadTabActions();
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
  const r = closeTabsToRight(tabs, "b", "d");
  assert.deepEqual(r.tabs.map((t) => t.id), ["a", "b"]);
  assert.equal(r.activeTabId, "b", "active fell off the right → becomes the anchor id");
});

test("tabsToRightCount counts only tabs strictly to the right", async () => {
  const { tabsToRightCount } = await loadTabActions();
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
  assert.equal(tabsToRightCount(tabs, "a"), 3);
  assert.equal(tabsToRightCount(tabs, "c"), 1);
  assert.equal(tabsToRightCount(tabs, "d"), 0);
  assert.equal(tabsToRightCount(tabs, "zzz"), 0);
});

test("duplicateTab inserts a deep clone right after the source and activates it", async () => {
  const { duplicateTab } = await loadTabActions();
  const tabs = [tab("a"), tab("b", { requestBody: '{"x":1}', origin: "saved", response: { ok: true }, isLoading: true }), tab("c")];
  const r = duplicateTab(tabs, "b", "b_copy");

  assert.deepEqual(r.tabs.map((t) => t.id), ["a", "b", "b_copy", "c"], "copy sits right after source");
  assert.equal(r.activeTabId, "b_copy", "the copy becomes active");

  const copy = r.tabs.find((t) => t.id === "b_copy");
  assert.equal(copy.requestBody, '{"x":1}', "request body copied verbatim");
  assert.equal(copy.origin, null, "copy is a fresh working tab, not the saved item");
  assert.equal(copy.response, null, "response is not carried over");
  assert.equal(copy.isLoading, false, "loading state resets");
});

test("duplicateTab deep-clones metadata so editing the copy never mutates the source", async () => {
  const { duplicateTab } = await loadTabActions();
  const tabs = [tab("b")];
  const r = duplicateTab(tabs, "b", "b_copy");
  const copy = r.tabs.find((t) => t.id === "b_copy");
  copy.metadata[0].value = "MUTATED";
  const src = r.tabs.find((t) => t.id === "b");
  assert.equal(src.metadata[0].value, "Bearer x", "source header untouched");
});

test("duplicateTab is a no-op when the id is unknown", async () => {
  const { duplicateTab } = await loadTabActions();
  const tabs = [tab("a")];
  const r = duplicateTab(tabs, "zzz", "new");
  assert.deepEqual(r.tabs.map((t) => t.id), ["a"]);
});

test("moveTab drags a tab to the right (lands after the target)", async () => {
  const { moveTab } = await loadTabActions();
  const tabs = ["a", "b", "c", "d"].map((id) => tab(id));
  assert.deepEqual(moveTab(tabs, "a", "c").map((t) => t.id), ["b", "c", "a", "d"]);
});

test("moveTab drags a tab to the left (lands before the target)", async () => {
  const { moveTab } = await loadTabActions();
  const tabs = ["a", "b", "c", "d"].map((id) => tab(id));
  assert.deepEqual(moveTab(tabs, "d", "b").map((t) => t.id), ["a", "d", "b", "c"]);
});

test("moveTab swaps adjacent tabs from either direction", async () => {
  const { moveTab } = await loadTabActions();
  const tabs = ["a", "b"].map((id) => tab(id));
  assert.deepEqual(moveTab(tabs, "a", "b").map((t) => t.id), ["b", "a"]);
  assert.deepEqual(moveTab(tabs, "b", "a").map((t) => t.id), ["b", "a"]);
});

test("moveTab is a no-op onto itself or an unknown id", async () => {
  const { moveTab } = await loadTabActions();
  const tabs = ["a", "b", "c"].map((id) => tab(id));
  assert.deepEqual(moveTab(tabs, "b", "b").map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(moveTab(tabs, "zzz", "a").map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(moveTab(tabs, "a", "zzz").map((t) => t.id), ["a", "b", "c"]);
});

test("moveTab does not mutate the input array", async () => {
  const { moveTab } = await loadTabActions();
  const tabs = ["a", "b", "c"].map((id) => tab(id));
  moveTab(tabs, "a", "c");
  assert.deepEqual(tabs.map((t) => t.id), ["a", "b", "c"]);
});
