// broker-scope-fixtures.test.tsx — the contract half of the
// SHIPPED_SCOPE / TOPIC_STATS_REQUEST_SCOPE pact.
//
// Whole-stage review item 4: this file and
// `src-tauri/src/broker/stats_tests.rs`'s
// `topic_stats_request_scope_matches_the_shipped_scope_fixture_the_ts_side_reads`
// both read the exact same checked-in file,
// `src-tauri/tests/fixtures/broker/shipped-stats-request-scope.json`, and
// each compares it against their own side's constant. Neither side can
// import the other's source across the Rust/TypeScript boundary, so the
// fixture is the one shared source of truth both are pinned against.
//
// If `TOPIC_STATS_REQUEST_SCOPE` (Rust) ever changes, the Rust test fails
// first — the fixture no longer matches the constant. Fixing that means
// editing the fixture file, which immediately desyncs it from this file's
// still-unedited `SHIPPED_SCOPE` import: the very next `pnpm test:ui` run
// then fails THIS test, loudly, until `SHIPPED_SCOPE` in
// `broker-scope-fixtures.ts` is updated to match. Neither side can drift
// without the other noticing — this test is deliberately trivial (a deep
// equality check against a JSON file), because its entire value is in
// existing at all.
//
// Imported as a plain module (not read via `node:fs`) so this file
// typechecks under this project's browser-only `tsconfig.json` (no Node
// type declarations are available to `src/`) while still reading the exact
// bytes on disk — Vite resolves a `.json` import to its parsed contents at
// both test-run and build time, the same way
// `src/components/layout/StatusBar.tsx` imports `package.json`.
import { describe, expect, it } from "vitest";
import fixture from "../../src-tauri/tests/fixtures/broker/shipped-stats-request-scope.json";
import { SHIPPED_SCOPE } from "./broker-scope-fixtures";

describe("SHIPPED_SCOPE matches the Rust TOPIC_STATS_REQUEST_SCOPE constant", () => {
  it("equals the checked-in fixture both sides are pinned against", () => {
    expect(SHIPPED_SCOPE).toEqual(fixture);
  });

  it("every flag is false — the actual shipped configuration", () => {
    // Spelled out explicitly, not just via the fixture equality above: a
    // reader should not have to open the JSON file to know what
    // SHIPPED_SCOPE means. If this ever needs to change, it must change
    // alongside a real change to the Rust constant, never on its own.
    expect(SHIPPED_SCOPE).toEqual({
      preciseBacklog: false,
      subscriptionBacklogSize: false,
      earliestTimeInBacklog: false,
      excludePublishers: false,
      excludeConsumers: false,
    });
  });
});
