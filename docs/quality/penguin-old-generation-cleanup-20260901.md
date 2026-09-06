# Penguin obsolete generation cleanup receipt — 2026-09-01

This receipt records the exact stale rollback copy removed to create enough
space for the current schema-v17 corpus baseline and guarded full reset.

- Removed path:
  `/Users/shieng/.penguin/knowledge/generations/round17-preactivation-20260830T205709Z`
- Role recorded by its `activation.json`: pre-activation backup for the Round
  17 candidate activated at `2026-08-30T20:57:09.872Z`.
- Database size: `12,706,869,248` bytes.
- Directory allocation before removal: `12,433,980` KiB.
- Database modification time: `2026-08-31 02:31:30` local time.
- Stored schema version read directly in read-only mode: `14`.
- Current live database path remains:
  `/Users/shieng/.penguin/knowledge/knowledge.db`.
- Current runtime target at cleanup:
  `/Users/shieng/.penguin/runtimes/1.16.0-e8a4de3a97fde19b`.
- Current MCP target at cleanup:
  `/Users/shieng/.penguin/mcp/generations/12765c69a2ed6a33`.
- `lsof` found no process holding the stale database, WAL, SHM, or ledger.
- Search found no external configuration reference to this generation; the
  only textual references were inside its own `activation.json`.

This obsolete schema-v14 copy cannot satisfy the plan's requirement for a
fresh immutable backup of the current schema-v17 database. It was therefore
removed before creating that new backup. No source repository, current live
database, current runtime, current MCP generation, notes, or protected assets
were removed by this cleanup.

Recovery: the removed stale generation is not recoverable from Trash. The
current live database was untouched and a new consistent backup must be
created and verified before the guarded reset is allowed.
