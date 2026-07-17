# Troubleshooting

All commands are read-only unless explicitly marked as a mutation. Resolve the repository/revision scope before treating an empty result as proof of absence.

Every entry below has the same prohibited shortcut: do not bypass scope, confirmation, integrity, secret-redaction, or rollback checks; do not hand-edit SQLite or delete a backup to make a diagnostic appear healthy.

## NO_MATCH

- Symptom: the expected symbol or text is absent.
- Diagnostic: `penguin search "<query>" --json`, then `penguin coverage --json` and `penguin snapshots --json`.
- Healthy output: the intended snapshot is resolved and `warnings` does not contain `SCOPE_EMPTY` or `COVERAGE_INCOMPLETE`.
- Root causes: wrong repo/branch/snapshot, excluded file, stale index, or query mode too narrow.
- Safe fix: retry with explicit `--repo`, `--branch`, `--mode auto`, then reindex the selected repo.
- Rollback: retain the prior snapshot and discard the new failed index attempt.

## COVERAGE_INCOMPLETE

- Symptom: diagnostics report excluded or failed files.
- Diagnostic: `penguin coverage --json --repo <repo>`.
- Healthy output: `failed=0`; exclusions are intentional and documented.
- Root causes: vendor/generated policy, unreadable file, unsupported encoding, or symlink boundary.
- Safe fix: fix permissions/encoding or add a reviewed coverage-policy exception; never silently admit vendor data.
- Rollback: restore the previous artifact if the policy change increases false positives or secret exposure.

## INDEX_STALE

- Symptom: diagnostics report stale coverage or a revision does not match the working tree.
- Diagnostic: `penguin status --json` and `penguin snapshots --json`.
- Healthy output: selected snapshot is `ready` and coverage stale count is zero.
- Root causes: source changed after indexing, interrupted watcher, or old branch pointer.
- Safe fix: run `penguin index <repo>` or rebuild the exact revision.
- Rollback: keep the old ready snapshot published until the replacement passes doctor.

## FTS5_TRIGRAM_UNAVAILABLE

- Symptom: source search falls back to a scan or reports unavailable trigram acceleration.
- Diagnostic: `penguin doctor --json` and `penguin search "<query>" --mode exact --json`.
- Healthy output: doctor reports the trigram tables and source line index healthy.
- Root causes: old schema, partial migration, or imported artifact missing derived tables.
- Safe fix: run the supported migration/rebuild; do not hand-edit SQLite tables.
- Rollback: restore the last artifact whose doctor report was healthy.

## REGEX_UNSUPPORTED

- Symptom: regex query is rejected.
- Diagnostic: `penguin search "<pattern>" --mode regex --json`.
- Healthy output: RE2-compatible pattern returns a typed response.
- Root causes: backreferences, look-behind, invalid flags, or budget exceeded.
- Safe fix: rewrite using RE2 syntax or narrow `--repo/--path`; use exact search when a literal is intended.
- Rollback: no data mutation occurs; revert only the query configuration.

## SEMANTIC_UNAVAILABLE

- Symptom: semantic/blend request returns deterministic lanes with a warning.
- Diagnostic: `penguin doctor --json` and inspect provider health; never send source to a remote provider without explicit allowlist/acknowledgement.
- Healthy output: local provider is healthy, or the response explicitly identifies deterministic fallback.
- Root causes: provider not configured, vector store stale, dimension mismatch, or remote endpoint policy rejection.
- Safe fix: repair/rebuild local embeddings or use `semantic=off`; do not weaken exact lanes.
- Rollback: disable the provider and remove only its derived vectors.

## CURSOR_STALE

- Symptom: page 2 returns `CURSOR_STALE` or `CURSOR_INVALID`.
- Diagnostic: retry the same request without `--cursor` and compare scope/capability hash.
- Healthy output: page 1 returns a fresh cursor for the same normalized request.
- Root causes: revision changed, capability drift, cursor expiry, or altered filters.
- Safe fix: restart at page 1; never reuse a cursor across snapshots.
- Rollback: no data mutation occurs.

## CAPABILITY_MISMATCH

- Symptom: CLI/MCP/Wiki or resident hello hashes differ.
- Diagnostic: `penguin capabilities --json` and `penguin doctor --json`.
- Healthy output: one capability hash is shared by all bundled surfaces.
- Root causes: stale bundle, partial install, or mixed package versions.
- Safe fix: rebuild and reinstall the complete bundle; stop the resident child before retrying.
- Rollback: restore the previous signed bundle and its matching artifact.

## knowledge_tool_missing

- Symptom: MCP tools/list lacks a required canonical capability.
- Diagnostic: run `pnpm run knowledge:parity` and inspect the installed MCP package path.
- Healthy output: missing/unimplemented/mismatch arrays are empty.
- Root causes: stale `~/.penguin/mcp`, package install failure, or manifest drift.
- Safe fix: run package smoke/install for the current release; do not edit generated tool lists manually.
- Rollback: point MCP back to the previous known-good bundle.

## Native or WASM load failure

- Symptom: better-sqlite3 ABI error or tree-sitter/WASM load error.
- Diagnostic: `pnpm run typecheck`, `penguin doctor --json`, and package smoke.
- Healthy output: native ABI matches Node and all required WASM resources resolve from the bundle.
- Root causes: wrong Node executable, stale native build, or missing packaged resource.
- Safe fix: rebuild native dependencies with the bundled/runtime Node and reinstall resources.
- Rollback: use the previous bundle; never replace native binaries in place while the app is running.

## readonly database

- Symptom: SQLite reports a read-only database or WAL checkpoint failure.
- Diagnostic: `penguin status --json`, `ls -l ~/.penguin/knowledge/knowledge.db`, and verify the enclosing directory is writable.
- Healthy output: the process owner can create/update the WAL and ledger.
- Root causes: wrong owner, read-only volume, stale lock, or two incompatible writers.
- Safe fix: stop writers, fix ownership/permissions, then reopen; do not use `chmod 777`.
- Rollback: restore the last backup into a writable path and run doctor.

## Runtime crash loop

- Symptom: resident queries return `RUNTIME_RESTARTED` followed by `RUNTIME_CIRCUIT_OPEN`.
- Diagnostic: inspect stderr/runtime doctor and verify bundled Node, CLI, capability hash, and DB path.
- Healthy output: one child stays alive across repeated queries and circuit is closed.
- Root causes: child crash, protocol corruption, hash mismatch, or native/WASM failure.
- Safe fix: stop the runtime, repair the bundle/DB, and restart once; preserve crash evidence.
- Rollback: disable resident mode only through the explicit diagnostic fallback, then restore the prior bundle.

## Artifact signature failure

- Symptom: import returns `ARTIFACT_SIGNATURE_INVALID` or `CAPABILITY_MISMATCH`.
- Diagnostic: validate the artifact without restore and compare manifest hash/key provenance.
- Healthy output: checksums, signature, capability, schema, and contract all match.
- Root causes: wrong key, modified artifact, incompatible release, or truncated transfer.
- Safe fix: obtain the artifact again from the signed release and matching key owner.
- Rollback: active DB is untouched; use the last verified artifact.

## Revision content unavailable

- Symptom: a hit locator exists but source preview cannot be opened.
- Diagnostic: `penguin get-hit <path> --snapshot <id> --json` and `penguin snapshots --json`.
- Healthy output: snapshot is ready and the source fact/blob exists for the locator.
- Root causes: metadata-only index, pruned blob, wrong snapshot, or artifact exported without source.
- Safe fix: select a source-inclusive artifact or reindex the exact revision.
- Rollback: keep metadata-only artifact read-only and return its evidence gap.
