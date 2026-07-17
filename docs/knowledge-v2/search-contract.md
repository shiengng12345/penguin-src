# Search contract

V2 requests support `exact`, `phrase`, `substring`, `path`, `regex`, `auto` and optional semantic blend. Deterministic hits are verified and include file path, line and byte offsets. A zero-result response includes coverage and warnings; it is not proof that excluded or failed files do not contain the query.

Cursor tokens are HMAC signed, request-bound, capability-hash-bound and expire. `CURSOR_INVALID` means tampering or malformed data; `CURSOR_STALE` means the request or capability set changed.
