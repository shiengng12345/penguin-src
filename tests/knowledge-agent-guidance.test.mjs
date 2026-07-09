import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeAgentGuidance } from "../packages/knowledge-indexer/dist/index.js";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "pk-guide-"));
}

const BEGIN = "<!-- BEGIN PENGUIN KNOWLEDGE (auto-managed) -->";
const END = "<!-- END PENGUIN KNOWLEDGE (auto-managed) -->";

test("creates CLAUDE.md and AGENTS.md with the managed block", () => {
  const repo = tempRepo();
  const { written } = writeAgentGuidance(repo);
  assert.equal(written.length, 2);
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const body = readFileSync(join(repo, name), "utf8");
    assert.ok(body.includes(BEGIN) && body.includes(END));
    assert.ok(body.includes("penguin context"));
  }
});

test("is idempotent — a second run writes nothing", () => {
  const repo = tempRepo();
  writeAgentGuidance(repo);
  const { written } = writeAgentGuidance(repo);
  assert.deepEqual(written, []);
});

test("preserves the user's own content and appends the block once", () => {
  const repo = tempRepo();
  const user = "# My Project\n\nSome existing notes.\n";
  writeFileSync(join(repo, "CLAUDE.md"), user);
  writeAgentGuidance(repo);
  const body = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.ok(body.startsWith("# My Project"), "user content kept on top");
  assert.equal(body.indexOf(BEGIN), body.lastIndexOf(BEGIN), "block appears exactly once");
  // Re-running still leaves exactly one block.
  writeAgentGuidance(repo);
  const again = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.equal(again.indexOf(BEGIN), again.lastIndexOf(BEGIN));
});

test("replaces a stale managed block in place without touching surrounding prose", () => {
  const repo = tempRepo();
  const stale = `# Top\n\n${BEGIN}\nOLD PENGUIN TEXT\n${END}\n\n## Footer kept\n`;
  writeFileSync(join(repo, "AGENTS.md"), stale);
  const { written } = writeAgentGuidance(repo);
  assert.ok(written.some((p) => p.endsWith("AGENTS.md")));
  const body = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.ok(!body.includes("OLD PENGUIN TEXT"), "stale block replaced");
  assert.ok(body.includes("# Top") && body.includes("## Footer kept"), "surrounding prose kept");
  assert.ok(body.includes("penguin context"));
});
