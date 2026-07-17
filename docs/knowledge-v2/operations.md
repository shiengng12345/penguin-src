# Operations

Routine checks: `penguin status --json`, `penguin coverage --json`, `penguin doctor --json`, `penguin capabilities --json`. Reindex after source changes; use the resident runtime for repeated Wiki queries. For historical source recovery, run `penguin source backfill --dry-run --repo <repo> --json` first, then remove `--dry-run` only after every unavailable revision is reviewed. Keep artifact exports and the vault backup together. Never delete external indexes before two independent release candidates and an operator-approved rollback rehearsal.
