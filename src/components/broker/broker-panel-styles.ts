// broker-panel-styles — the shared vocabulary for the three severities every
// read-only broker panel renders: a hard failure (destructive/alert), a
// plain informational status (neutral), and an indeterminate check (amber,
// deliberately never destructive). Hoisted out of `AnomalyPanel.tsx` and
// `TopicDetailPanel.tsx`, where these four strings used to be copy-pasted
// verbatim (fix round 1, item 3).
//
// The alert-versus-indeterminate colour distinction is load-bearing, not
// cosmetic: it is how a reader tells "something is wrong" (`ALERT_CLASS`,
// `role="alert"`) apart from "a check could not run" (`INDETERMINATE_CLASS`,
// `role="status"`, amber rather than destructive red — see both panels'
// `IndeterminateSection`). A contrast or a11y fix applied to one copy and
// not the other would silently break that distinction in half the app;
// importing from here instead of redeclaring keeps it one fix, not two.

/** A hard failure — the query itself failed, or a concrete anomaly was
 *  found. Always paired with `role="alert"`. */
export const ALERT_CLASS =
  "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive";

/** A plain, neutral status: loading, all-clear, an empty namespace, or a
 *  `"stale"`/`"partial"` warning list. Always paired with `role="status"`. */
export const STATUS_CLASS =
  "rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground";

/** A check that could not run. Amber, never destructive-red, because an
 *  `IndeterminateCheck` is not a claim that something is wrong — only that
 *  a check had no evidence to run on. Always paired with `role="status"`,
 *  never `role="alert"`. */
export const INDETERMINATE_CLASS =
  "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300";

/** A caveat on data already on screen, not an alert about something wrong
 *  (same rationale as `DeliveryNotice`, which pairs this with `role="note"`).
 *  Used by `AnomalyPanel`'s truncation notice. */
export const NOTE_CLASS = "rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground";
