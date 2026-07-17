# Architecture

`knowledge-contracts` owns the Search/Coverage response contracts and capability manifest. `knowledge-core` owns revision scope, source blobs, FTS, graph queries, evidence and artifact validation. `knowledge-indexer` discovers Git-truth files and writes parser-independent source facts. CLI and MCP adapt inputs; Wiki calls the CLI/runtime bridge. Tauri owns a resident JSONL query worker but never reimplements query semantics.

The source model is content-hash deduplicated and snapshot/COW based: a branch stores overlays, while effective manifests resolve inherited source facts. Every result carries a revision locator and evidence status.
