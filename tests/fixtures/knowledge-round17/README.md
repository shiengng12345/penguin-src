# Round17 knowledge closure fixtures

`knowledge-round17-closure.test.mjs` creates each fixture in a temporary Git repository and temporary SQLite `KnowledgeStore`; this directory intentionally contains no persisted database or source fixture.

The fixture models one changed symbol, one transitive caller, one `tests` edge, and one `handles` edge. It also creates a second repository for ownership rejection and duplicate bare/package-qualified gRPC endpoints for canonicalization checks.

The fixtures are test-only. They must not read, change, index, or depend on the real FPMS-NT repository.
