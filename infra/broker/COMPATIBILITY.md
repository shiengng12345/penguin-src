# Broker module — pinned compatibility

| Item | Value | Verified |
|---|---|---|
| Pulsar image digest | `sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4` | 2026-09-15 |
| Broker version (`GET /admin/v2/brokers/version`) | `4.2.4` | 2026-09-15 |
| Cluster name | `standalone` | 2026-09-15 |
| Admin REST | `http://localhost:8080` | 2026-09-15 |
| Binary protocol | `pulsar://localhost:6650` | 2026-09-15 |
| Rust client crate | `pulsar` 6.9.0 (streamnative/pulsar-rs) | 2026-09-15 |

## Rules

- `latest` is forbidden in compose files and CI. Pin by digest.
- Changing the digest requires re-running `pnpm broker:probe` and updating this table.
