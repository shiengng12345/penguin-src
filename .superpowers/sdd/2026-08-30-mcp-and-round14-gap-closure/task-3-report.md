# Task 3A MCP/CLI parity evidence

## Provenance

- Target commit: `0505f85b7f2d52d1165ffe7740f30afcb5e13ce8`
- Bundle capture commit: `0505f85b7f2d52d1165ffe7740f30afcb5e13ce8`
- Target/bundle commit correspondence: **verified**; both values were resolved by `git rev-parse` during the same parity run.
- CLI bundle SHA-256: `d6bb9836d2257f042960dbf2f7235d2c83ac38df6179eab590f01af2cd989e84`
- MCP bundle SHA-256: `62cc0c8b6db37286f076b7fd29ab95b004c7a708282d07b3a648e6fb710d11a2`
- Bundle ID: `8338fdf10a896374e74bb37c5d9921bb3702b3e088a9fcf99c59ca253a205b41` (SHA-256 of the exact CLI and MCP bundle hashes)
- Runtime build ID: `8338fdf10a896374e74bb37c5d9921bb3702b3e088a9fcf99c59ca253a205b41`; CLI capabilities and MCP initialize both reported this value.
- CLI launcher tracking: **verified** by `git ls-files --error-unmatch scripts/knowledge-cli-launcher.mjs`; the launcher is included in this change and is not read from an untracked workspace-only path.
- Worktree at capture: dirty with 65 pre-existing entries. This run is therefore not claimed as a clean-tree parity pass; the commit/bundle correspondence above is independently recorded instead of being inferred from “old commit + dirty”.

## Targeted run

Command:

```bash
PENGUIN_PARITY_REPORT=/tmp/task-3-report.md rtk node scripts/knowledge-mcp-parity-test.mjs
```

- Real processes: CLI and MCP both started.
- Checks: 16
- Failed: 1
- Failure: `mcp-tools-process` detected 21 duplicate listed capability IDs and exited non-zero as required.
- Duplicate IDs: `knowledge.get_node`, `knowledge.architecture`, `knowledge.index_status`, `knowledge.graph.query`, `knowledge.dead_code`, `knowledge.communities`, `knowledge.analyze_repository`, `knowledge.package_dependencies`, `knowledge.dependency_path`, `knowledge.compare_branches`, `knowledge.status_panel`, `knowledge.note.write`, `knowledge.link.create`, `knowledge.suggestion.list`, `knowledge.suggestion.accept`, `knowledge.suggestion.reject`, `knowledge.api_doc.generate`, `knowledge.api_doc.list`, `knowledge.api_doc.show`, `knowledge.api_doc.diff`, `knowledge.set_master_branch`.
- Listed tools: 143 total; 120 canonical capability-bearing tools.

The non-zero result is intentional evidence that duplicate IDs are a hard parity failure, not a pass condition. The remaining 15 checks passed.

## Static verification

- `node --check scripts/knowledge-mcp-parity-test.mjs` — PASS.
- `node --check scripts/knowledge-cli-launcher.mjs` — PASS.
- Static assertion for the duplicate-ID failure gate and target/bundle provenance fields — PASS.
