# Penguin Knowledge Round 17 Closure Result

Date: 2026-08-31 (Asia/Kuala_Lumpur)

## Decision

**Internal Claude Code/Codex status: GO — 95/100.**

This score is frozen against the Round 17 G1–G9 contract. It is not a public-release score and it is not a claim that every possible code question is answered exhaustively. Penguin now clears the internal 95 threshold because both installed adapters agree on one build and revision, all frozen semantic gates pass, and completely new Claude Code and Codex processes can call the installed MCP without manual configuration overrides.

## Accepted installed candidate

| Field | Accepted value |
| --- | --- |
| App version | `1.16.0` |
| Runtime build ID | `1.16.0-9dd8e41c775cb77d` |
| Capability hash | `40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0` |
| Knowledge schema | `15` |
| Contract version | `2` |
| FPMS-NT snapshot | `snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3` |
| FPMS-NT commit | `3f0f1984b9e4337668529a13bad5264501729908` |
| FPMS-NT branch | `brazil-v2` |
| Installed app | `/Applications/Penguin.app` |
| DMG | `/Users/shieng/Desktop/Pengvi/src-tauri/target/release/bundle/dmg/Penguin_1.16.0_aarch64.dmg` |

The candidate index covers the 20 selected repositories. FPMS-NT reports `discovered=3340`, `admitted=3333`, `excluded=7`, `failed=0`, and `stale=0` on the accepted snapshot.

## Frozen gate result

The installed command below exited `0` and emitted `passed:true`, an empty `failures` list, and one aligned build/hash/revision:

```bash
node scripts/knowledge-round17-acceptance.mjs --repo FPMS-NT --gate
```

| Gate | Result | Accepted evidence |
| --- | --- | --- |
| G1 affected/adapter parity | PASS | CLI and MCP build/hash match; file and node affected results match |
| G2 repository isolation | PASS | Wrong-scope endpoint returns `SCOPE_MISMATCH` in CLI and MCP |
| G3 endpoint truth | PASS | 604 FPMS-NT endpoints paginate consistently; canonical aliases and handler truth agree |
| G4 context/flow first hop | PASS | CLI context, CLI flow, MCP context and MCP flow return the same proven `handles` tuple |
| G5 freshness/revision truth | PASS | All ten sampled surfaces use the accepted snapshot; freshness is `fresh` while coverage remains `partial` |
| G6 typed errors | PASS | Invalid query/repo/branch/file/node/cursor return the required typed non-zero errors |
| G7 ID/cursor continuity | PASS | Emitted node ID round-trips; endpoints 604, filesymbols 4 and deadcode 5,647 exhaust without reconstruction |
| G8 API/list honesty | PASS | Stale API previews remain `not_proven`; notes remain `lower_bound/candidate` with named gaps |
| G9 fresh clients | PASS | Independent new Claude Code and Codex processes replayed the same packet and node ID |

## Fresh-client evidence

### Codex

- Fresh ephemeral session: `01a054a5-58e7-7931-9d04-d65a4c0a367a`
- Approval policy: `never`; sandbox: `read-only`
- No temporary `-c` MCP override was supplied.
- `knowledge_capabilities`: succeeded automatically.
- Frozen G1–G8 process exit: `0`.
- Exact G7 node replayed through `knowledge_context`: `node_b532eeda-cac4-46bc-9f1d-00d0d0135960`.
- Verdict: `PASS`; limitations returned by the client: `[]`.

### Claude Code

- Fresh no-persistence session: `a3aa9607-8a02-403d-ae4b-2edb337f6689`
- Claude Code version: `2.1.251`.
- Allowed only read MCP tools and Bash; edit/write tools were disabled.
- `knowledge_capabilities`: succeeded from the installed Penguin MCP.
- Frozen G1–G8 process exit: `0`.
- The same G7 node ID replayed through `knowledge_context`.
- Verdict: `PASS`; limitations returned by the client: `[]`.

## Product fixes closed in this candidate

1. MCP `tools/list` now publishes canonical read-only/mutating annotations.
2. Penguin startup refreshes Claude Desktop, Claude Code and Codex client configuration even for a same-version internal replacement.
3. Codex receives `default_tools_approval_mode="writes"` plus explicit approval for MCP tools advertised as read-only. Mutating index/note/import operations remain protected.
4. Runtime health checks verify `initialize`, `mcp_health`, and `tools/list` before writing client configuration.
5. Round 17 transport failures retain timeout/exit evidence instead of being projected as empty graph answers.
6. Revision Context Pack relation assembly was reduced from 14 repeated snapshot scans to at most two bounded scans. On the real FPMS-NT database, warm CLI context latency fell from approximately `5.91–9.06s` to `1.03–1.04s`; the measured cold result was `5.44s`.

## Verification executed

| Verification | Result |
| --- | --- |
| `pnpm typecheck` | PASS, no TypeScript errors |
| Full `pnpm test` | PASS, exit `0` after the new G4 performance regression was added to the frozen fixture set |
| Context/round17 focused tests | PASS |
| Rust library tests | PASS, 126 tests |
| Internal `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'` | PASS; app and DMG produced |
| Installed G1–G8 gate | PASS after runtime alignment |
| Fresh Codex G9 | PASS |
| Fresh Claude Code G9 | PASS |

## Honest limitations and why the score is not 100

1. **Coverage is partial.** Seven FPMS-NT files are explicitly excluded. Penguin therefore cannot use an empty result as proof of complete absence across those files.
2. **Reference resolution is incomplete.** The accepted FPMS-NT coverage reports `103958` unresolved references. Deterministic known edges remain useful, but dynamic/reflection/DI paths can still be lower-bound.
3. **API/Wiki provenance is honest but not complete.** Existing API previews are stale/not-proven, and the current note list has unavailable revision/index-node provenance. The product labels these gaps instead of claiming exhaustive truth.
4. **Vector retrieval is not active yet.** The workspace declares `sqlite-vec 0.1.9` and contains vector-store infrastructure, but the installed self-contained runtime does not currently package the `sqlite-vec` module. A workspace-assisted live-store probe found zero embedding models, zero semantic chunks, zero ready vector references, and zero vectors. Current production search is graph/lexical, not semantic vector search.
5. **Startup has a short runtime-switch window.** An acceptance process launched immediately after `open -a` observed the old CLI build and new MCP build in the same packet. The stable symlink then aligned to the new build and all later direct/fresh-client gates passed. Clients should be started after Penguin finishes startup; a future readiness barrier can remove this observable transition.
6. **Public release gates were intentionally excluded.** The internal build did not create signed updater artifacts. Code signing/notarization and updater publication remain release work, not internal 95 blockers.

## Observed failed probes retained as evidence

The closure does not erase failures that led to the final fixes:

- An earlier installed build intermittently timed out on CLI `context` while MCP and CLI `flow` were correct. CPU profiling proved repeated revision-edge scans; the new regression test failed with 14 scans before the fix and passes with at most two afterward.
- The first fresh Codex replay before this candidate could see Penguin MCP but approval policy `never` blocked read calls. Installed startup configuration now fixes this without auto-approving mutations.
- The first gate started immediately during final runtime publication saw CLI build `1.16.0-a1074fe21c456a56` and MCP build `1.16.0-9dd8e41c775cb77d`. The post-alignment gate and both fresh clients used only `1.16.0-9dd8e41c775cb77d`.

## Rollback

The previous applications remain recoverable at:

- `/Applications/Penguin.app.round17-preinstall-20260831T053245+0800`
- `/Applications/Penguin.app.round17-pre-context-fix-20260831T054500+0800`
- `/Applications/Penguin.app.round17-preactivation-20260830T205709Z`

The pre-activation knowledge backup remains at:

- `/Users/shieng/.penguin/knowledge/generations/round17-preactivation-20260830T205709Z`

No public release, updater publication, git commit, reset, or cleanup was performed as part of this closure.

## Stop rule

Round 17 is closed at **95/100 for internal Claude Code/Codex use**. Do not invent a Round 18 question pack to move this goalpost. New work should be tracked as a separate capability roadmap, led by hybrid graph + lexical + vector retrieval, embedding lifecycle, benchmark quality, and startup readiness—not as a retroactive failure of the frozen Round 17 contract.
