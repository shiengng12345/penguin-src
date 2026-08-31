import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Round19: active brief pointer references Round 19 with correct hash", () => {
  const activeBriefPath = resolve(root, "docs/quality/index-evaluation-brief.md");
  const round19BriefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");

  // Read the active pointer
  const activeContent = readFileSync(activeBriefPath, "utf8");

  // Assert it mentions Round 19
  assert.ok(
    activeContent.includes("Round 19") || activeContent.includes("round19") || activeContent.includes("Round19"),
    "Active brief should reference Round 19"
  );

  // Assert Round 19 brief file exists
  let round19Content;
  try {
    round19Content = readFileSync(round19BriefPath, "utf8");
  } catch (error) {
    assert.fail(`Round 19 brief file should exist at ${round19BriefPath}`);
  }

  // Calculate SHA-256 of Round 19 brief
  const actualHash = createHash("sha256").update(round19Content).digest("hex");

  // Extract hash from active pointer (assuming format includes hash)
  const hashMatch = activeContent.match(/([a-f0-9]{64})/);
  if (hashMatch) {
    const declaredHash = hashMatch[1];
    assert.equal(
      actualHash,
      declaredHash,
      `Round 19 brief hash mismatch: expected ${declaredHash}, got ${actualHash}`
    );
  }

  // Assert the required report filename mentions Round 19
  assert.ok(
    activeContent.includes("round19") ||
    activeContent.includes("Round 19") ||
    activeContent.includes("Round19"),
    "Active pointer should specify Round 19 as the active version"
  );
});

test("Round19: brief contains complete retained benchmark inventory", () => {
  const round19BriefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");
  const round19Content = readFileSync(round19BriefPath, "utf8");

  // Assert benchmark inventory section exists
  assert.ok(
    round19Content.includes("Retained benchmark inventory"),
    "Round 19 brief must have 'Retained benchmark inventory' section"
  );

  // Assert Round 16 Q1-Q15 coverage
  assert.ok(
    round19Content.includes("Round 16 coverage (Q1-Q15)"),
    "Must document Round 16 Q1-Q15 coverage"
  );
  for (let i = 1; i <= 15; i++) {
    assert.ok(
      round19Content.match(new RegExp(`Q${i}[^0-9]`)),
      `Must mention Round 16 Q${i}`
    );
  }

  // Assert Round 17 Q1-Q20 and B1-B8 coverage
  assert.ok(
    round19Content.includes("Round 17 coverage (Q1-Q20, B1-B8)"),
    "Must document Round 17 Q1-Q20 and B1-B8 coverage"
  );
  for (let i = 1; i <= 20; i++) {
    assert.ok(
      round19Content.match(new RegExp(`Q${i}[^0-9]`)),
      `Must mention Round 17 Q${i}`
    );
  }
  for (let i = 1; i <= 8; i++) {
    assert.ok(
      round19Content.match(new RegExp(`B${i}[^0-9]`)),
      `Must mention Round 17 B${i}`
    );
  }

  // Assert Round 18 Q1-Q20 and B1-B8 coverage
  assert.ok(
    round19Content.includes("Round 18 coverage (Q1-Q20, B1-B8)"),
    "Must document Round 18 Q1-Q20 and B1-B8 coverage"
  );

  // Assert vector lifecycle/quality coverage
  assert.ok(
    round19Content.includes("Vector lifecycle and quality"),
    "Must document vector lifecycle and quality coverage"
  );
  assert.ok(
    round19Content.includes("semantic") || round19Content.includes("vector"),
    "Vector section must mention semantic or vector search"
  );

  // Assert all gates G0-G12 are mentioned
  for (let i = 0; i <= 12; i++) {
    assert.ok(
      round19Content.match(new RegExp(`G${i}[^0-9]`)),
      `Must define gate G${i}`
    );
  }

  // Assert execution order is specified
  assert.ok(
    round19Content.includes("Execution order"),
    "Must specify execution order for gates"
  );
});

test("Round19: runner and contract are aligned with brief", () => {
  const round19BriefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const contractPath = resolve(root, "tests/fixtures/knowledge-round19/expected-contract.json");

  const round19Content = readFileSync(round19BriefPath, "utf8");
  const runnerContent = readFileSync(runnerPath, "utf8");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));

  // Assert runner implements all gates G0-G12
  for (let i = 0; i <= 12; i++) {
    const gatePattern = i === 0
      ? /gate\(\s*["']G0["']/
      : new RegExp(`gate\\(\\s*["']G${i}[.0-9]*["']`);
    assert.ok(
      runnerContent.match(gatePattern),
      `Runner must implement gate G${i}`
    );
  }

  // Assert contract defines all gates
  assert.equal(Object.keys(contract.gateDefinitions).length, 13, "Contract must define 13 gates (G0-G12)");
  for (let i = 0; i <= 12; i++) {
    assert.ok(
      contract.gateDefinitions[`G${i}`],
      `Contract must define G${i}`
    );
  }
});

test("Round19: no skip-as-pass paths in required gates", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Gates that depend on upstream data and must NOT have skip-as-pass
  const requiredGates = ["G2.1", "G2.2", "G2.3", "G5", "G6", "G7", "G8", "G9", "G11"];

  for (const gateId of requiredGates) {
    // Find gate definition
    const gateStartPattern = new RegExp(`gate\\(\\s*["']${gateId.replace(".", "\\.")}["']`, "g");
    const hasGate = gateStartPattern.test(runnerContent);
    assert.ok(hasGate, `Gate ${gateId} not found in runner`);

    // Search for skip-as-pass pattern around this gate
    // We'll check that the runner doesn't have 'skipped: true' for these gates
    const lines = runnerContent.split('\n');
    let inGate = false;
    let gateDepth = 0;
    let gateBody = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes(`gate("${gateId}"`) || line.includes(`gate('${gateId}'`)) {
        inGate = true;
        gateDepth = 0;
        gateBody = '';
      }

      if (inGate) {
        gateBody += line + '\n';
        // Track braces
        for (const char of line) {
          if (char === '{') gateDepth++;
          if (char === '}') gateDepth--;
        }

        // End of gate function
        if (gateDepth < 0) {
          // Check for skip-as-pass
          assert.ok(
            !gateBody.includes('skipped: true'),
            `Gate ${gateId} must NOT return { skipped: true } - should fail/throw when required data missing`
          );

          // Assert presence of required data check
          assert.ok(
            gateBody.includes('assert(') && (gateBody.includes('Required upstream data missing') ||
                                             gateBody.includes('searchFilePath') ||
                                             gateBody.includes('endpointId') ||
                                             gateBody.includes('searchNodeId')),
            `Gate ${gateId} must assert required upstream data availability`
          );

          inGate = false;
          break;
        }
      }
    }

    assert.ok(!inGate || gateDepth === 0, `Failed to parse gate ${gateId}`);
  }
});

test("Round19: brief documents private deployment boundary", () => {
  const round19BriefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");
  const round19Content = readFileSync(round19BriefPath, "utf8");

  // Assert private deployment boundary is documented
  assert.ok(
    round19Content.includes("Private deployment boundary") || round19Content.includes("private deployment boundary"),
    "Brief must document private deployment boundary"
  );

  assert.ok(
    round19Content.includes("owner-local") || round19Content.includes("admin"),
    "Brief must mention owner-local or admin privileges"
  );

  assert.ok(
    round19Content.includes("MCP") && (round19Content.includes("consumer") || round19Content.includes("external")),
    "Brief must mention MCP consumers or external users"
  );

  assert.ok(
    round19Content.toLowerCase().includes("no local cli") || round19Content.toLowerCase().includes("mcp-only"),
    "Brief must mention MCP-only or no local CLI for external users"
  );
});

test("Round19: gate() propagates evidence.passed === false", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Assert gate() function checks evidence.passed === false
  assert.ok(
    runnerContent.includes('if (evidence && evidence.passed === false)'),
    "gate() must check evidence.passed === false"
  );
  assert.ok(
    runnerContent.includes('gateResult.passed = false'),
    "gate() must set gateResult.passed = false when evidence.passed === false"
  );
});

test("Round19: G2.3 enforces first page items and safety cap", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Find G2.3 gate body
  const g23Match = runnerContent.match(/gate\("G2\.3"[^}]+\{([^]*?)\n  \}\);/);
  assert.ok(g23Match, "G2.3 gate not found");
  const g23Body = g23Match[1];

  // Assert first page has items check
  assert.ok(
    g23Body.includes('firstPage.json.items') && g23Body.includes('length > 0'),
    "G2.3 must assert first page has at least one item"
  );

  // Assert safety cap check
  assert.ok(
    g23Body.includes('safetyPageCap') || g23Body.includes('page < 50'),
    "G2.3 must have safety page cap"
  );
  assert.ok(
    g23Body.includes('safety page cap') && g23Body.includes('assert'),
    "G2.3 must fail if safety cap reached"
  );
});

test("Round19: G7 fails when steps is empty", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Find G7 gate body
  const g7Match = runnerContent.match(/gate\("G7"[^}]+\{([^]*?)\n  \}\);/);
  assert.ok(g7Match, "G7 gate not found");
  const g7Body = g7Match[1];

  // Assert steps must not be empty
  assert.ok(
    g7Body.includes('steps.length > 0') && g7Body.includes('assert'),
    "G7 must fail when steps is empty"
  );

  // Assert depth-0 root required
  assert.ok(
    g7Body.includes('depth === 0') || g7Body.includes('depth: 0'),
    "G7 must require depth-0 root step"
  );

  // Assert via field required
  assert.ok(
    g7Body.includes('root.via'),
    "G7 must check root.via field"
  );
});

test("Round19: G10 remains non-passing until actual MCP parity", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Find G10 gate using narrow source window
  const g10Start = runnerContent.indexOf('gate("G10"');
  assert.ok(g10Start !== -1, "G10 gate not found");

  // Extract bounded window: from gate("G10" to next gate or result construction
  const nextGateStart = runnerContent.indexOf('gate("G11"', g10Start + 1);
  const g10WindowEnd = nextGateStart !== -1 ? nextGateStart : runnerContent.indexOf('const result =', g10Start);
  const g10Window = runnerContent.substring(g10Start, g10WindowEnd);

  // Assert passed: false appears explicitly in G10 window
  const passedFalseOccurrences = (g10Window.match(/passed:\s*false/g) || []).length;
  assert.ok(
    passedFalseOccurrences >= 1,
    `G10 must contain explicit 'passed: false'. Found ${passedFalseOccurrences} occurrences in G10 block.`
  );

  // Assert status is not_proven
  assert.ok(
    g10Window.includes('status: "not_proven"') || g10Window.includes("status: 'not_proven'"),
    "G10 must report status as not_proven"
  );
});

test("Round19: G11 requires relation and complete provenance", () => {
  const runnerPath = resolve(root, "scripts/knowledge-round19-acceptance.mjs");
  const runnerContent = readFileSync(runnerPath, "utf8");

  // Find G11 gate body
  const g11Match = runnerContent.match(/gate\("G11"[^}]+\{([^]*?)\n  \}\);/);
  assert.ok(g11Match, "G11 gate not found");
  const g11Body = g11Match[1];

  // Assert fails when no relation
  assert.ok(
    g11Body.includes('allEdges.length > 0') && g11Body.includes('assert'),
    "G11 must fail when there is no relation"
  );

  // Assert requires edge type
  assert.ok(
    (g11Body.includes('hasEdgeType') || g11Body.includes('edge type')) && g11Body.includes('assert'),
    "G11 must require edge type"
  );

  // Assert requires evidence state/confidence
  assert.ok(
    (g11Body.includes('hasConfidence') || g11Body.includes('confidence') || g11Body.includes('state')) && g11Body.includes('assert'),
    "G11 must require evidence state/confidence"
  );

  // Assert requires source attribution
  assert.ok(
    (g11Body.includes('hasSource') || g11Body.includes('source') || g11Body.includes('filePath')) && g11Body.includes('assert'),
    "G11 must require source attribution"
  );

  // Assert requires response-level trust/revision
  assert.ok(
    (g11Body.includes('trust') || g11Body.includes('revision')) && g11Body.includes('assert'),
    "G11 must require response-level trust/revision fields"
  );
});
