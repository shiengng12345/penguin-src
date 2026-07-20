# Universal Retrieval Plan Execution Log

更新时间：2026-07-18

本文件记录本轮继续执行时的可复核证据；代码、测试和 release gate 是最终权威，百分比只按主计划 checkbox 计数。

## Baseline / current verification

- 分支：`feature/knowledge-core`；工作树改动均为本任务继续实现的文件，未覆盖未知用户改动。
- 仓库根存在 `.codegraph/`；源码定位先使用 CodeGraph/Penguin，再读取实现和测试。
- `rtk npm run typecheck`：通过。
- `rtk cargo test --manifest-path src-tauri/Cargo.toml resident_runtime`：2 passed。
- `rtk test node --test tests/knowledge-query-runtime-e2e.test.mjs tests/knowledge-query-protocol.test.mjs`：通过，包含 cancel/concurrency/child replacement。
- `rtk test node --test tests/knowledge-artifact-roundtrip.test.mjs`：通过，包含 checksum/signature/encryption/dry-run/tombstone/ZIP symlink。
- `rtk test node --test tests/knowledge-workspace-scope.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-mcp-tools.test.mjs`：通过。
- `rtk test node --test tests/knowledge-saved-query.test.mjs tests/knowledge-search-engine.test.mjs`：通过，包含 Obsidian Markdown 与 prompt-like compact/hydration 不变性。
- `rtk test node --test tests/knowledge-*.test.mjs tests/wiki-search-*.test.mjs`：通过，0 fail；期间修复了未配置 allow-list 时 CLI 显式临时路径的兼容回归。
- 当前 release gate（2026-07-18，`PENGUIN_RC_ID=progress-20260718`）：通过。typecheck、surface parity、package smoke、10,000 needles universal benchmark、110/110 real-question audit、competitor differential 均 exit 0。

## Safety / artifact evidence

- CLI allow-list：`PENGUIN_KNOWLEDGE_ALLOWED_ROOTS`；未配置时以 cwd 为默认 root。
- CLI compatibility：未配置 allow-list 时保留原有显式 `init/index/rebuild/watch <path>` 行为；配置 allow-list 后强制执行 canonical realpath scope。
- MCP roots：`PENGUIN_MCP_WORKSPACE_ROOTS` 在 server module load 时固定；请求不能扩大 root。
- realpath 校验覆盖 lexical traversal、macOS `/var` symlink 和目录 symlink escape。
- artifact export 先 checkpoint/integrity-check，再用 SQLite `serialize()` 生成镜像；不直接复制活跃 WAL 文件。
- artifact import 拒绝 absolute、`..`、反斜杠和 Unix ZIP symlink metadata。
- artifact dry-run 通过 normalized remote fingerprint 优先识别 repo；同名但不同 remote 不自动合并。

## Known explicit blockers still requiring implementation/evidence

- language/framework resolver fixtures（overload、DI、protocol、IaC、LSP provider）。
- Postgres schema-only external source lifecycle。
- logical add-only artifact delta（当前仍是 fixed-chunk delta + tombstone）。
- real workspace 仍有 7 个历史 revision content hash unavailable，不能伪造 source。
- RC1/RC2 必须在本轮最终代码稳定后重新构建；旧 RC fingerprint 不可复用。
- CodeGraph/Graphify 下线仍需 operator 明确批准，未执行删除。

## Latest continuation evidence

- canonical contract input schemas 已由 `packages/knowledge-contracts/src/input-schemas.ts` 统一生成；MCP `tools/list` 对所有工具绑定 canonical capability ID 后，`tests/knowledge-surface-parity.test.mjs` 8/8 通过。
- 补齐 `api_doc_list/show/diff` 与 `compare_branches` 等非 `knowledge_*` MCP 工具的 canonical ID 推导；没有遗留孤立 schema 入口。
- 新增/修复后的 targeted tests：field graph、symbol overload identity、legacy search facade、Postgres schema-only、workspace scope、shadow weekly review 共 9/9 通过。
- 完整回归期间发现 search engine 的 compatibility symbol lane 在“尚未发布到 branch 的 building snapshot”上错误套用了 revision filter；已改为仅对已绑定 branch 的 snapshot 使用 branch-backed revision view，`knowledge-search-engine` 19/19 通过，revision isolation 32/32 已通过。
- 当前主计划 checkbox：428/481（88.98%）。旧 release-gate 结果不覆盖本次新改动，需在最终稳定后重新执行。
- 本轮新增：`ResolutionProviderChain` 提供 parser/project/LSP/framework/heuristic 边界、provider/config hash 绑定、cache invalidation 和 bounded timeout；`tests/knowledge-resolution-provider.test.mjs` 2/2 通过。
- 本轮新增：artifact `logical-row-v1` delta，包含 changed rows、删除操作、表创建和 tombstone；旧 fixed-chunk delta 保持导入兼容，`tests/knowledge-artifact-roundtrip.test.mjs` 14/14 通过。

## Continuation correction (2026-07-18)

The older baseline bullets above are historical and do not represent the current
worktree. Current plan count is **460/481 (95.6341%)**. The following evidence is
from the current source after that baseline:

- `knowledge-dispatch-resolution.test.mjs` + `knowledge-graph-query.test.mjs`: framework dispatch, DI/interface candidate sets, runtime scoping, and explicit `dispatches_to` graph hops pass.
- `knowledge-data-flow.test.mjs`: verified-only inter-procedural flow passes; candidate edges stop with an explicit gap.
- `knowledge-grpc-flow-regression.test.mjs`: every cross-service flow symbol hop now carries repo/file/line source and all 7 tests pass.
- `knowledge-iac.test.mjs`: deployment blast radius separates explicit locator facts from name heuristics; 2/2 pass.
- `knowledge-cli.test.mjs` + `knowledge-mcp-tools.test.mjs`: Postgres schema register/list/sync/remove lifecycle with guarded removal and host-owned read-only adapter; combined CLI/MCP/Wiki cycle is 39/39 pass.
- CLI implementation split: public `packages/knowledge-cli/src/index.ts` is now boundary/parse/dispatch only; command body is in `command-dispatch.ts`, parser in `args.ts`.
- `rtk npm run typecheck` passed after the latest changes. Previous release-gate/RC reports remain stale and must not be treated as final evidence.

Remaining explicit items are the superiority scoring gate, final plan self-audit,
and the post-RC CodeGraph/Graphify removal sequence, which requires operator
approval and is intentionally not executed automatically.

## Fresh verification (2026-07-18)

- `knowledge-universal-retrieval-benchmark.mjs --root=/Users/shieng/Desktop/Pengvi --limit=10000 --gate --performance-gate` completed successfully: 805 admitted files, 10,000 needles, exact recall 1.0, path recall 1.0, locator accuracy 1.0, unexpected verified hits 0, failed coverage 0, exact p95 39.43ms, structural p95 6.47ms.
- The broad knowledge/wiki test run reached 513 passing subtests before the process retained runtime handles; the only observed failure was a stale source-path assertion caused by the CLI split. It was corrected to inspect `command-dispatch.ts`, and `knowledge-index-progress.test.mjs` then passed 3/3.
- Current checkbox count remains 472/481 (98.1289%). The benchmark is evidence for universal retrieval, not competitor superiority; no Penguin per-question competitor score has been fabricated.

## Post-removal final gate (2026-07-18)

- `docs/knowledge-v2/release-gate-post-removal-20260718-r4.json` passed.
- All six release-gate stages exited 0: typecheck, surface parity, package smoke, 10,000-needle universal benchmark, 110-question real-question audit, and competitor differential.
- The benchmark excludes generated evidence reports from the source corpus while retaining source/docs/JSONL inputs; coverage was 828 discovered, 802 admitted, 26 excluded, 0 failed, with exact/path/locator recall all 1.0 and performance gates passing.
- External-tool quarantine remains intentionally active from 2026-07-18 through no earlier than 2026-07-25; deletion still requires a new confirmation and gate.
