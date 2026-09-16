// broker-scope-fixtures — the one `StatsRequestScope` every broker UI test
// should render under by default.
//
// Whole-stage review item 4 (the root cause behind items 1 and 2 shipping
// unseen): every UI test fixture in this codebase used to hand-roll a scope
// with every flag `true` — `preciseBacklog: true, subscriptionBacklogSize:
// true, earliestTimeInBacklog: true` — which the application can never
// actually emit. `src-tauri/src/broker/stats.rs`'s `TOPIC_STATS_REQUEST_SCOPE`
// (what `PulsarAdminRest::get_topic_stats` actually sends) has all five
// flags `false`. So not one of this project's UI tests rendered the panel
// the way the shipped app renders it — which is exactly how item 1
// (`msgBacklog` wrongly hidden behind "Not requested") reached `HEAD`
// unseen: every test that would have exercised that column used a scope
// where the defect happened to be invisible.
//
// `SHIPPED_SCOPE` below is that real constant, restated in TypeScript. It
// must be the default fixture in every broker UI test; `ALL_REQUESTED_SCOPE`
// exists only for tests explicitly about `StatsRequestScope`'s scoped
// behaviour (Task 1/R38, and the whole-stage-review item 1/2/3 fixes),
// where deliberately varying one flag away from the shipped baseline is the
// point of the test.
//
// This file's values are asserted, not just documented, to match the Rust
// constant — see `broker-scope-fixtures.test.tsx`'s contract test, which
// reads the same checked-in fixture
// (`src-tauri/tests/fixtures/broker/shipped-stats-request-scope.json`) that
// `src-tauri/src/broker/stats_tests.rs` pins `TOPIC_STATS_REQUEST_SCOPE`
// against. A future change to the Rust constant has to update that JSON
// fixture to keep `cargo test` green, which immediately desyncs this file
// from the fixture — so `pnpm test:ui` then fails loudly on the TS side
// too, until `SHIPPED_SCOPE` below is updated to match.
import type { StatsRequestScope } from "@penguin/broker-contracts";

/** The scope this codebase's `/stats` calls actually send in production.
 *  Mirrors `TOPIC_STATS_REQUEST_SCOPE` in `src-tauri/src/broker/stats.rs`
 *  field-for-field. Use this as the default `scope` prop/fixture in every
 *  broker UI test. */
export const SHIPPED_SCOPE: StatsRequestScope = {
  preciseBacklog: false,
  subscriptionBacklogSize: false,
  earliestTimeInBacklog: false,
  excludePublishers: false,
  excludeConsumers: false,
};

/** A scope with every "did this call ask" flag on — the application never
 *  actually sends this. Use it only in a test that is explicitly about
 *  `StatsRequestScope`'s scoped-field behaviour (comparing what renders
 *  when a flag is on vs. off); every other test should use `SHIPPED_SCOPE`
 *  instead, so it renders the panel the way an operator actually sees it. */
export const ALL_REQUESTED_SCOPE: StatsRequestScope = {
  preciseBacklog: true,
  subscriptionBacklogSize: true,
  earliestTimeInBacklog: true,
  excludePublishers: false,
  excludeConsumers: false,
};
