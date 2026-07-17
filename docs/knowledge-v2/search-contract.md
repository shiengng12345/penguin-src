# Search contract

V2 requests support `exact`, `phrase`, `substring`, `path`, `regex`, `auto` and optional semantic blend. Deterministic hits are verified and include file path, line and byte offsets. A zero-result response includes coverage and warnings; it is not proof that excluded or failed files do not contain the query.

Cursor tokens are HMAC signed, request-bound, capability-hash-bound and expire. `CURSOR_INVALID` means tampering or malformed data; `CURSOR_STALE` means the request or capability set changed.

## Read-only graph migration

Do not send raw Cypher to Penguin. Translate common read-only patterns into the
bounded `knowledge.graph.query` request:

| Legacy intent | Typed request shape |
|---|---|
| `MATCH (n:Service) RETURN n LIMIT 20` | `start.kinds=["service"]`, `traverse=[]`, `limit=20` |
| callers of a symbol | `start.nodeIds=[id]`, `traverse=[{direction:"in", edgeTypes:["CALLS"], minDepth:1, maxDepth:1, statuses:["verified"]}]` |
| bounded dependency walk | explicit `edgeTypes`, `direction`, `maxDepth<=12`, and `limit<=500` |

The typed DSL is read-only, revision-scoped, cycle-bounded, and returns compact
locators for hydration. It deliberately has no SQL, procedure, file I/O, or
network expression; unsupported Cypher must be rewritten as a typed request or
reported as an honest gap.
