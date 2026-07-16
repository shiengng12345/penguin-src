# Penguin three-plan acceptance matrix

This is the local acceptance record for the Branch Revision/COW, SLS Evidence + Wiki, and API Documentation Generator plans.

## Branch Revision/COW

| Scenario | Evidence |
| --- | --- |
| Empty database / first index | `tests/knowledge-index-recovery-scenarios.test.mjs` reconstructs code facts after deleting SQLite and ledger state. |
| Existing index / rebuild | The same test rebuilds an already indexed repository and verifies the new symbol. |
| Explicit branch, commit, snapshot, ambiguity | `tests/knowledge-revision-context.test.mjs` and `tests/knowledge-revision-isolation.test.mjs`. |
| On-demand cold materialization | `penguin materialize <repo> --branch <name>` and `--commit <sha>` are implemented; the CLI regression verifies the snapshot is ready without moving the branch pointer. |
| Base + COW overlay | `tests/knowledge-revision-indexer.test.mjs` verifies add/delete overlays, inherited unchanged facts, and branch isolation. |
| Fleet multi-branch order/isolation | `tests/knowledge-canonical-master-acceptance.test.mjs` covers five branches, shared/changed/added/deleted/renamed files, a branch containing `master`, and exact Git-tree manifests. |
| Manual overlay rebuild | `tests/knowledge-file-facts.test.mjs` deletes `effective_snapshot_files` and rebuilds the manifest byte-for-byte. |
| Inherited resolution refs | `openRevisionView()` walks immutable base snapshots; `tests/knowledge-revision-view.test.mjs` verifies COW edges remain readable after legacy rows are removed. |
| Failed index publication | `tests/knowledge-branch-lifecycle.test.mjs` verifies the previous live branch remains usable. |
| Retention / pins / deployments / references | `tests/knowledge-revision-retention.test.mjs`. |
| CLI/MCP/UI revision metadata | CLI `status --revisions`, MCP revision envelopes, core trust envelope, and Wiki branch rows expose snapshot/base/head/cache/reuse state. |

## SLS Evidence + Wiki

| Scenario | Evidence |
| --- | --- |
| Multiple targets and URL normalization | `tests/sls-target-registry.test.mjs`, `tests/log-investigation.test.mjs`. |
| Bounded planning and continuation | `tests/log-query-planner.test.mjs`, `tests/log-investigation.test.mjs`. |
| Partial sibling failure and no-overclaim | `tests/log-evidence-correlator.test.mjs`. |
| Exact runtime commit provenance | The correlator preserves resolver-provided repo/branch/commit/snapshot/trust; regression coverage is in `tests/log-evidence-correlator.test.mjs` and `tests/knowledge-code-version-resolver.test.mjs`. |
| Evidence note idempotency and sensitive data | `tests/evidence-note.test.mjs`; notes are Markdown-backed and searchable after reindex. |
| SQLite deletion / note recovery | `tests/evidence-note.test.mjs` reindexes Markdown after deleting SQLite. |
| CLI/MCP evidence lifecycle and repair | `tests/log-investigation-contract.test.mjs`, `tests/mcp-input-validation.test.mjs`, and the evidence lifecycle handlers. |

SLS live verification is intentionally not represented as a local pass: it requires Aliyun credentials and an approved read-only SLS MCP client. The implementation keeps target, region, project, logstore, timestamps, query hash, bounded raw evidence, and failure status separate so a live smoke can be run without changing the data model.

## API Documentation Generator

| Scenario | Evidence |
| --- | --- |
| Stable identity and revision set | `tests/api-doc-ir.test.mjs`. |
| Complete proto schema / incomplete metadata gaps | `tests/proto-schema-parity.test.mjs`. |
| Request classes and response outcome classes | `tests/api-doc-request-analyzer.test.mjs`, `tests/api-doc-response-analyzer.test.mjs`. |
| Evidence, examples, coverage truth table | `tests/api-doc-evidence.test.mjs`, `tests/api-doc-coverage.test.mjs`; unresolved evidence/revision fails closed and examples redact credentials. |
| Deterministic renderer and partial coverage | `tests/api-doc-renderer.test.mjs`. |
| Immutable preview, diff, idempotency, revision references | `tests/api-doc-preview-store.test.mjs`. |
| Explicit multi-repo Lark binding | `tests/api-doc-binding-store.test.mjs`. |
| Managed sync, conflict, refetch, journal-safe behavior | `tests/api-doc-lark-sync.test.mjs`. |
| CLI generate/list/show/diff and bounded request input | `tests/api-doc-cli.test.mjs`. |

The local suite uses a fake Lark client and performs no canonical Lark write. A real draft/sync smoke requires an explicitly disposable parent token and separate approval. No generated prose is inserted into Knowledge facts; previews retain exact source revision and evidence references.

## Final verification commands

Run with the Penguin desktop native runtime Node `v18.20.8`:

```text
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" pnpm typecheck
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" pnpm test
git diff --check
```
