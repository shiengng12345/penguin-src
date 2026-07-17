# Rollback runbook

Stop watcher/runtime, preserve the failing DB, restore the previous signed artifact and vault backup, run `penguin doctor`, then replay fixed queries and compare normalized locators. Re-enable external tools only if the operator chooses it. Never overwrite the failing database before copying it for diagnosis.
