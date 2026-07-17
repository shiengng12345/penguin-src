# Knowledge V2 release gate

The release gate is intentionally fail-closed. Run `pnpm run knowledge:release-gate` after building the core, CLI, indexer and MCP packages. The universal benchmark must be run against a real admitted corpus with `--limit=10000`; the competitor differential only becomes a gate after independently frozen CodeGraph/Graphify outputs are supplied.

No report from this directory is allowed to claim competitor superiority when a baseline is missing.

The real-question differential freezes the captured baseline versions in
`docs/knowledge-v2/competitor-differential.json`; the current reviewed corpus
contains 110 questions, 110 CodeGraph captures, 110 Graphify captures, and no
honest gaps. This is evidence of a complete comparison input, not by itself a
claim that Penguin wins every quality dimension.
