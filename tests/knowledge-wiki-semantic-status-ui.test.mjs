import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const panel = readFileSync(new URL("../src/components/wiki/SemanticWorkerPanel.tsx", import.meta.url), "utf8");

test("semantic worker panel renders every canonical lifecycle state truthfully", () => {
  for (const state of [
    "disabled", "chunks_ready", "queued", "embedding", "pausing", "paused",
    "retry_wait", "stalled", "active", "superseded", "cancelled",
  ]) assert.match(panel, new RegExp(`${state}:`));
  assert.match(panel, /restartRequired/);
  assert.match(panel, /MODEL_IDENTITY_MISMATCH|model unavailable/i);
});

test("semantic worker panel polls durable state and refreshes on Tauri events", () => {
  assert.match(panel, /2_000/);
  assert.match(panel, /30_000/);
  assert.match(panel, /onSemanticStatusChanged/);
  assert.match(panel, /knowledgeSemanticStatus/);
});

test("semantic worker panel exposes pause resume retry and guarded cancel", () => {
  assert.match(panel, />Pause</);
  assert.match(panel, />Resume</);
  assert.match(panel, />Retry failed</);
  assert.match(panel, />Cancel generation</);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /knowledgeSemanticControl/);
});
