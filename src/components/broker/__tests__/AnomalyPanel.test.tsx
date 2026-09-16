// AnomalyPanel tests — the Overview surface answers "what is wrong", never
// "how many topics exist" (ruling D-A3). Every test here guards one of the
// three states this panel must keep apart: genuinely all-clear, "some
// checks could not run" (which must never read as all-clear), and "the
// query itself failed" (which must never read as good news because the
// anomaly list happens to be empty). The truncation tests guard a fourth,
// related trap: an empty result over a partial sample is not a clean bill
// of health for the whole namespace.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Anomaly, IndeterminateCheck } from "@penguin/broker-contracts";
import { AnomalyPanel } from "../AnomalyPanel";

// Typed explicitly against `Anomaly`/`IndeterminateCheck` rather than left
// to inference: a bare object literal infers `kind: string`, which lets a
// PascalCase or otherwise-wrong `AnomalyKind` slip through every UI test
// (Vitest transpiles without typechecking) and fail only `pnpm typecheck` —
// exactly the trap task-13-brief.md's controller correction calls out.
const anomalies: Anomaly[] = [
  {
    kind: "backlogWithNoConsumer", // camelCase on the wire — see anomaly.ts
    topic: "persistent://public/default/fpms_topup",
    subscription: "anti_addiction_deposit_limit_fpmsnt",
    detail: "subscription has a backlog but no connected consumer",
    observedValue: "3400 messages",
  },
];

const indeterminate: IndeterminateCheck[] = [
  {
    kind: "consumerBlockedOnUnacked",
    topic: "persistent://public/default/fpms_topup",
    subscription: "rg_deposit_accumulate_LOCAL",
    reason: "Pulsar did not report blockedOnUnackedMsgs for this consumer",
  },
];

describe("AnomalyPanel", () => {
  it("shows the measured value, not just the rule that fired", () => {
    // "has a backlog" is a rule. "3400 messages" is what an operator acts on.
    render(<AnomalyPanel anomalies={anomalies} indeterminate={[]} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/3400 messages/)).toBeInTheDocument();
  });

  it("names the subscription and topic involved", () => {
    render(<AnomalyPanel anomalies={anomalies} indeterminate={[]} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/anti_addiction_deposit_limit_fpmsnt/)).toBeInTheDocument();
  });

  it("says no anomalies found rather than rendering nothing", () => {
    // A blank panel cannot be told apart from a failed query. The whole point
    // of this surface is that silence means something specific.
    render(<AnomalyPanel anomalies={[]} indeterminate={[]} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no anomalies/i);
  });

  it("does not claim all-clear when the query failed", () => {
    render(
      <AnomalyPanel
        anomalies={[]}
        indeterminate={[]}
        state="error"
        errorMessage="Connection refused"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
    expect(screen.queryByText(/no anomalies/i)).not.toBeInTheDocument();
  });

  // The case the plan never wrote (controller correction, task-13-brief.md):
  // an empty `anomalies` array next to a non-empty `indeterminate` is not
  // "checked and clear" — it is "some checks had nothing to look at". That
  // distinction is the entire point of five backend tasks.
  it("does not read empty anomalies as all-clear when checks could not run", () => {
    render(
      <AnomalyPanel anomalies={[]} indeterminate={indeterminate} state="ready" onRefresh={vi.fn()} />,
    );
    expect(screen.queryByText(/no anomalies/i)).not.toBeInTheDocument();
    // The unrunnable check must be reported as a status, never an alarm —
    // an IndeterminateCheck is not a problem found.
    const notice = screen.getByRole("status");
    expect(notice).not.toHaveTextContent(/no anomalies/i);
    expect(notice).toHaveTextContent(/rg_deposit_accumulate_LOCAL/);
    expect(notice).toHaveTextContent(/could not/i);
  });

  it("never uses role=alert for an indeterminate check — it is not an alarm", () => {
    render(
      <AnomalyPanel anomalies={[]} indeterminate={indeterminate} state="ready" onRefresh={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // `truncated` plus the two counts are what stop "no anomalies" being
  // misread as "the namespace is clean" when only the first N of the
  // namespace's topics were actually sampled.
  it("surfaces truncation so an empty result is not read as a full sweep", () => {
    render(
      <AnomalyPanel
        anomalies={[]}
        indeterminate={[]}
        truncated={true}
        topicsSampled={50}
        topicsTotal={120}
        state="ready"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/50/)).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });

  it("does not mention truncation when the sample covered every topic", () => {
    render(
      <AnomalyPanel
        anomalies={[]}
        indeterminate={[]}
        truncated={false}
        topicsSampled={12}
        topicsTotal={12}
        state="ready"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText(/first 12/i)).not.toBeInTheDocument();
  });

  it("shows a loading status instead of rendering nothing while the query is in flight", () => {
    render(<AnomalyPanel anomalies={[]} indeterminate={[]} state="loading" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  // Fix round 1, item 2: a namespace with zero topics is not the same fact
  // as "every check ran and found nothing" — zero checks ran because there
  // was nothing to check. Asserting a sweep happened is the same defect as
  // the indeterminate case, in different clothes.
  it("says no topics rather than claiming every check ran when the namespace is empty", () => {
    render(<AnomalyPanel anomalies={[]} indeterminate={[]} state="empty" onRefresh={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/no topics/i);
    expect(status).not.toHaveTextContent(/every check ran/i);
  });
});
