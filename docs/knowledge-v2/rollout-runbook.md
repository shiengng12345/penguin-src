# Rollout runbook

1. Back up DB, vault and current artifact.
2. Run fixture, small, medium and multi-language canaries.
3. Record coverage, index time, DB size, RSS and 1,000 local needles per canary.
4. Enable shadow comparison without changing Penguin responses.
5. Build RC1 and RC2 independently; retain reports and hashes.
6. Stop before external-tool removal unless every gate and explicit approval exists.
