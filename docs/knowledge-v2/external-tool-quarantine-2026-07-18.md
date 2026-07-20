# External tool quarantine — 2026-07-18

## Removal record

- Penguin RC1: `rc1-20260718`, passed.
- Penguin RC2: `rc2-20260718`, passed.
- Active CodeGraph MCP entry removed from `/Users/shieng/.codex/config.toml`.
- Active Graphify hooks removed from `/Users/shieng/Desktop/Pengvi/.claude/settings.json`.
- Auto-managed CodeGraph instructions removed from `/Users/shieng/.codex/AGENTS.md` and `/Users/shieng/.claude/CLAUDE.md`; Penguin Knowledge instructions remain.
- `.codegraph/` and `graphify-out/` were not deleted. They are retained as rollback/quarantine data.

## Backups and rollback

- `/Users/shieng/.codex/config.toml.bak-penguin-20260718`
- `/Users/shieng/Desktop/Pengvi/.claude/settings.json.bak-penguin-20260718`
- Before-removal SHA-256: `59db74fa02faea5ee79255f87921b79b7461f21b139bfa3801e68bda0a0e3878` for Codex config; `0d49fe564756b78bfbbf782d9765fd8ef8bab74f6c8d12c6421f8ab99139f569` for Claude settings.

Rollback commands:

```bash
rtk proxy cp /Users/shieng/.codex/config.toml.bak-penguin-20260718 /Users/shieng/.codex/config.toml
rtk proxy cp /Users/shieng/Desktop/Pengvi/.claude/settings.json.bak-penguin-20260718 /Users/shieng/Desktop/Pengvi/.claude/settings.json
```

## Retention

Quarantine starts `2026-07-18` and ends no earlier than `2026-07-25`; retain both external indexes through that window. Deletion after the window requires a new explicit confirmation and a new release gate. No deletion has been performed in this change.
