# Penguin Knowledge V2

Penguin Knowledge V2 is a local, revision-aware knowledge system. Deterministic source/path search is authoritative; graph, notes, evidence, memory and optional semantic lanes add context without replacing source truth.

## Quick start

```bash
penguin init .
penguin index . --json
penguin search "needle" --mode exact --json
penguin coverage --json
penguin doctor --json
```

Read [search-contract.md](search-contract.md) before integrating CLI, MCP or Wiki.
