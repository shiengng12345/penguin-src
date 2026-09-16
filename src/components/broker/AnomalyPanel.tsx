// AnomalyPanel — the Overview surface. It answers "what is wrong", never
// "how many topics exist" (ruling D-A3): someone opens this first when
// something feels off, so it must never be mistaken for a topic-count
// dashboard, and it must never go blank.
//
// Three states this panel keeps apart, none of which may collapse into
// another:
//
// 1. Genuinely all-clear — `anomalies` empty AND `indeterminate` empty.
//    Every check ran and found nothing. Said plainly, in its own status.
// 2. "Could not tell" — `anomalies` empty but `indeterminate` non-empty.
//    This is the case the plan never wrote (task-13-brief.md's controller
//    correction): silence on `anomalies` alone is not "clean", it can also
//    mean a check never ran. This state must never render the words "no
//    anomalies" anywhere on screen, and is styled amber/`role="status"`
//    (per `TopicDetailPanel`'s `IndeterminateSection`) rather than
//    destructive-red/`role="alert"` — an unrunnable check is not an alarm.
// 3. The query failed (`state === "error"`) — an empty `anomalies` array
//    here must never be presented as good news. This branch never renders
//    the all-clear status at all.
//
// `truncated` is a fourth, related trap: an empty `anomalies` array over
// only the first `topicsSampled` of `topicsTotal` topics is not a claim
// about the whole namespace. Surfaced as its own notice, independent of
// whether anomalies were found, using `role="note"` (the same role
// `DeliveryNotice` uses for a caveat on data already on screen, not an
// alert about something wrong).
//
// `topicsUnavailable` (Phase A final review, finding 1) is a fifth trap,
// distinct from `truncated`: one *sampled* topic's stats fetch can fail
// without failing the whole overview (`sample_overview` in
// `commands/topic_detail.rs`), and that failure previously reached this
// panel only as free text buried in `warnings` — visible, but nothing
// `FindingsSection` could reason about. So the all-clear sentence rendered
// even while a warning right above it said a topic could not be checked.
// `FindingsSection` now suppresses "every check ran" whenever
// `topicsUnavailable > 0` or `truncated`, the same way it already
// suppresses it for a non-empty `indeterminate`.
//
// Reused from `TopicDetailPanel.tsx`: the anomalies-vs-indeterminate visual
// language (own heading each, amber non-alert styling for indeterminate,
// rendered independently of `anomalies`) and the `formatNumber`/status/alert
// class tokens. New here: the single-status "all clear" collapse (this
// panel's props are flat, not a nested report, and its own fixed test
// asserts exactly one `role="status"` node when both lists are empty), and
// the truncation notice, which `TopicDetailPanel` has no equivalent of
// (a single-topic view has nothing to truncate).
import type { Anomaly, IndeterminateCheck } from "@penguin/broker-contracts";
import type { DataTableState } from "@/components/ui/data-table-types";
import { Button } from "@/components/ui/button";
import { ALERT_CLASS, INDETERMINATE_CLASS, NOTE_CLASS, STATUS_CLASS } from "./broker-panel-styles";

export interface AnomalyPanelProps {
  anomalies: Anomaly[];
  /** Checks that could not run at all — never a duplicate of `Anomaly`.
   *  Required, not optional, mirroring `OverviewReport.indeterminate`
   *  (non-optional in the contract on purpose): an omitted prop must be a
   *  compile error, not a silent `[]` that reads as "confirmed every check
   *  ran" when the caller simply forgot to pass it. See the module doc's
   *  state 2 — a caller that forgets this is exactly how the sentence "no
   *  anomalies" gets produced while checks silently did not run. */
  indeterminate: IndeterminateCheck[];
  topicsSampled?: number;
  topicsTotal?: number;
  truncated?: boolean;
  /** How many sampled topics' stats fetches failed. Required, not optional,
   *  for the same reason `indeterminate` is (R23/R31): `0` is a real answer
   *  ("every sampled topic's stats were readable"), and an optional field
   *  would let a caller forget to pass a real report's count, silently
   *  restoring the exact claim this fix removes. See the module doc. */
  topicsUnavailable: number;
  state: DataTableState;
  errorMessage?: string;
  /** Warnings attached to a `"stale"`/`"partial"` result, same shape as
   *  `TopicDetailPanel`'s `warnings` prop. */
  warnings?: string[];
  onRefresh: () => void;
}

export function AnomalyPanel({
  anomalies,
  indeterminate,
  topicsSampled,
  topicsTotal,
  truncated = false,
  topicsUnavailable,
  state,
  errorMessage,
  warnings = [],
  onRefresh,
}: AnomalyPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <PanelHeader onRefresh={onRefresh} />

      {state === "error" ? (
        <div role="alert" className={ALERT_CLASS}>
          {errorMessage ?? "Failed to load the overview."}
        </div>
      ) : state === "loading" ? (
        <div role="status" className={STATUS_CLASS}>
          Loading overview…
        </div>
      ) : state === "empty" ? (
        // Fix round 1, item 2: zero topics is not "every check ran and
        // found nothing" — zero checks ran because there was nothing to
        // check. That sentence is vacuously true in the misleading way: it
        // asserts a sweep happened. Named separately so it can never say so.
        <div role="status" className={STATUS_CLASS}>
          This namespace has no topics. Nothing was checked.
        </div>
      ) : (
        <>
          {(state === "stale" || state === "partial") && warnings.length > 0 && (
            <div role="status" className={STATUS_CLASS}>
              <ul className="list-disc pl-4">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <TruncationNotice truncated={truncated} topicsSampled={topicsSampled} topicsTotal={topicsTotal} />
          <FindingsSection
            anomalies={anomalies}
            indeterminate={indeterminate}
            truncated={truncated}
            topicsUnavailable={topicsUnavailable}
          />
        </>
      )}
    </div>
  );
}

function PanelHeader({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-medium">Anomalies</h2>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}

/** A partial sample is not a claim about the whole namespace. Rendered
 *  independently of whether any anomaly was found — an empty `anomalies`
 *  array over a truncated sample is the exact case this notice exists to
 *  keep from being misread as "the namespace is clean". */
function TruncationNotice({
  truncated,
  topicsSampled,
  topicsTotal,
}: {
  truncated: boolean;
  topicsSampled?: number;
  topicsTotal?: number;
}) {
  if (!truncated) return null;
  return (
    <p role="note" className={NOTE_CLASS}>
      Showing the first {topicsSampled ?? "some"} of {topicsTotal ?? "an unknown number of"} topics in this
      namespace. This is a partial sample, not a full sweep — anomalies outside it would not appear here.
    </p>
  );
}

/** Phase A final review, finding 1: says what actually happened instead of
 *  claiming a sweep completed when it did not. `truncated` means the
 *  namespace itself was only partially sampled; `topicsUnavailable > 0`
 *  means a sampled topic's stats fetch failed. Either makes "every check
 *  ran" false, so this never returns the all-clear sentence when it holds —
 *  it names the specific reason instead. */
function incompleteSweepReason(truncated: boolean, topicsUnavailable: number): string | null {
  const reasons: string[] = [];
  if (truncated) {
    reasons.push("only a partial sample of the namespace was swept");
  }
  if (topicsUnavailable > 0) {
    reasons.push(`${topicsUnavailable} sampled topic${topicsUnavailable === 1 ? "" : "s"} could not be checked`);
  }
  return reasons.length === 0 ? null : reasons.join(" and ");
}

/** The one place the three findings states (all-clear / could-not-tell /
 *  found problems) resolve into what's on screen. Collapses to a single
 *  `role="status"` node only when both `anomalies` and `indeterminate` are
 *  empty — the genuinely all-clear case. Any non-empty `indeterminate`
 *  suppresses that "no anomalies" wording entirely, everywhere on the
 *  panel, so it can never be misread as good news. Same treatment for
 *  `truncated`/`topicsUnavailable` (finding 1): an incomplete sweep gets
 *  its own honest sentence instead of "every check ran". */
function FindingsSection({
  anomalies,
  indeterminate,
  truncated,
  topicsUnavailable,
}: {
  anomalies: Anomaly[];
  indeterminate: IndeterminateCheck[];
  truncated: boolean;
  topicsUnavailable: number;
}) {
  if (anomalies.length === 0 && indeterminate.length === 0) {
    const incomplete = incompleteSweepReason(truncated, topicsUnavailable);
    return (
      <div role="status" className={STATUS_CLASS}>
        {incomplete
          ? `No anomalies found among the topics that were checked — ${incomplete}, so this is not a complete sweep.`
          : "No anomalies found. Every check ran and found nothing wrong."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {anomalies.length > 0 && <AnomaliesSection anomalies={anomalies} />}
      {indeterminate.length > 0 && <IndeterminateSection checks={indeterminate} />}
    </div>
  );
}

/** Concrete, evidenced problems. Only rendered when non-empty — the empty
 *  case is handled once, above, by `FindingsSection`, together with
 *  `indeterminate`, so this component never has to speak for "clean". */
function AnomaliesSection({ anomalies }: { anomalies: Anomaly[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Anomalies</h3>
      <ul role="alert" className={`${ALERT_CLASS} flex flex-col gap-1`}>
        {anomalies.map((anomaly, index) => (
          <li key={`${anomaly.kind}-${anomaly.subscription ?? "topic"}-${index}`}>
            <span className="font-medium">{anomaly.kind}</span> on{" "}
            <span className="font-medium">{anomaly.topic}</span>
            {anomaly.subscription && <span> ({anomaly.subscription})</span>}: {anomaly.detail} — observed{" "}
            {anomaly.observedValue}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Checks that could not be evaluated — never a problem found, never
 *  `role="alert"`. Only rendered when non-empty for the same reason
 *  `AnomaliesSection` is: the empty case is spoken for once, by
 *  `FindingsSection`. Styled and worded exactly per
 *  `TopicDetailPanel.IndeterminateSection`: amber, "could not run", its
 *  own heading, never claiming a problem exists. */
function IndeterminateSection({ checks }: { checks: IndeterminateCheck[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Checks that could not run</h3>
      <ul role="status" className={`${INDETERMINATE_CLASS} flex flex-col gap-1`}>
        {checks.map((check, index) => (
          <li key={`${check.kind}-${check.subscription ?? "topic"}-${index}`}>
            <span className="font-medium">{check.kind}</span> on <span className="font-medium">{check.topic}</span>
            {check.subscription && <span> ({check.subscription})</span>} could not be evaluated:{" "}
            {check.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
