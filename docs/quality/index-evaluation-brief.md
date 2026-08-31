# Penguin Knowledge Evaluation Brief — Active Pointer

> This file is a pointer to the active immutable evaluation brief. It does not contain the questions themselves.

## Active Version

**Round 19** — Full closure benchmark (95-100% knowledge closure)

## Active Brief Location

```text
docs/quality/index-evaluation-brief-round19.md
```

## Brief SHA-256

```text
32759f9709dc562afe4523cf79ad10e12b912e78c3ab2cd43d7b4a8241c81f71
```

## Required Report Filename Pattern

```text
.superpowers/sdd/2026-08-31-penguin-knowledge-95-100-full-closure/round19-<evaluator>-<timestamp>.md
```

## Verification

Before running an evaluation, verify the brief file exists and its hash matches:

```bash
# macOS
shasum -a 256 docs/quality/index-evaluation-brief-round19.md

# Linux
sha256sum docs/quality/index-evaluation-brief-round19.md
```

Expected output:
```text
32759f9709dc562afe4523cf79ad10e12b912e78c3ab2cd43d7b4a8241c81f71  docs/quality/index-evaluation-brief-round19.md
```

## Purpose

Round 19 is an immutable, deterministic acceptance gate with:
- Frozen contract expectations (G0-G12)
- Deterministic target selection after concept queries
- Machine-readable JSON output
- No evaluator-specific refinements allowed
- Reproducible results across Claude Code and Codex

## Previous Versions

- Round 15: Fresh evaluation after Round 14 runtime/identity/pagination fixes (archived)
- Round 16-18: (development iterations, not released)
- Round 19: Current active version

## Usage

Run the acceptance test:

```bash
# Full acceptance test
pnpm knowledge:round19:acceptance

# Fixture validation only
pnpm knowledge:round19:acceptance -- --fixtures-only

# Gate mode (exit 1 on failure)
pnpm knowledge:round19:acceptance -- --gate
```
