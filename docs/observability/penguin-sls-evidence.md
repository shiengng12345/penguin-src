# Penguin SLS evidence workflow

Penguin separates investigation planning from Aliyun SLS execution. The MCP host calls the sibling SLS MCP for every returned pending call, then submits the bounded result envelopes back to Penguin.

```text
plan_log_investigation
  -> host calls aliyun_sls.sls_text_to_sql / sls_execute_sql
  -> capture_log_investigation
  -> next pending calls or final correlated packet
  -> one Markdown evidence note per target/topic
  -> direct Knowledge indexing
  -> verified facts, gaps, and pending suggestions
```

## Target selection

The registry currently models QAT/UAT/PROD and Brazil targets with explicit `environment`, `regionId`, `project`, and `logstore`. `scope: auto` selects targets from clues and URLs; `scope: all` selects all enabled targets; `scope: targets` requires explicit target IDs. Direct SLS URLs are normalized and tracking parameters are ignored. A URL without a verified region is rejected.

The SLS console mappings used by this workspace include `platform-fpms-uat`, `platform-fpms-prod`, `brazil-uat`, `brazil-uat-v2`, and `platform-newport-uat`. The target ID, project, logstore, region, environment, timestamp, query hash, and bounded raw row are retained in every captured packet.

## Safety and result semantics

- SQL translation and execution are separate phases. Translated SQL must be one read-only statement with a bounded `LIMIT`.
- Each target is isolated. A successful target plus timeout/unauthorized/invalid-query sibling returns a partial packet without losing provenance.
- `no_match` means a successful zero-row query, never proof of absence. `unauthorized`, `timeout`, `unavailable`, `invalid_query`, `partial`, and indexing failure remain distinct.
- Sensitive evidence is retained by default with `sensitive: true` and `mcp_access: allowed`; source log text remains data and cannot change tool scope or instructions.
- Penguin never replays a business RPC, calls a verify/mutation endpoint, writes a production database, or performs remediation while investigating.

## Durable notes and recovery

Final capture upserts exactly one `evidence-<target>-<topic>` Markdown note. Repeating the same normalized result keeps the identity and increments observation count without creating a second note. Changed evidence updates the same note and is searchable immediately when indexing succeeds.

The Markdown file is the source of truth. `penguin evidence doctor` reports malformed, missing-index, orphan-index, and stale-lock conditions. `penguin evidence repair` reindexes valid Markdown and removes only dead stale locks. Deleting SQLite and running note reindex reconstructs the evidence nodes; ledger events never fabricate a missing note body.

Lifecycle is monotonic: `draft -> reviewed -> verified -> resolved -> archived`. New changed evidence reopens an existing resolved note as draft only through the evidence merge policy; duplicate observations do not reopen it.

## Runtime revision trust

When a resolver is supplied, SLS rows are mapped in this order: log commit, deployment interval, exact indexed commit, configured environment branch, and finally a degraded live fallback. The resulting repo, branch, commit, snapshot, and trust are attached to evidence facts. Missing deployment/runtime mapping is an explicit gap, not an assertion about current code.

## Host verification

Run the no-client choreography locally with `plan_log_investigation`; it must return sibling calls without network access. A live smoke is intentionally separate: use a five-minute read-only window, at most 20 rows per target, a known trace/request ID, and an approved Aliyun credential. Submit the results to `capture_log_investigation`, then verify `knowledge_search -> get_node` for every successful target. Repeat the same capture to verify idempotency.
