# Legacy search compatibility window

The core `search(store, text, options)` remains an array-shaped compatibility
facade for existing integrations. It preserves the legacy row fields and
attaches the canonical `schemaVersion: "2"` response as `result.v2` during the
migration window. The Wiki path already calls the canonical v2 client directly.

New CLI/MCP/Wiki code must use the canonical `knowledge.search` request and
`SearchResponse` directly. The legacy facade is scheduled for removal in
version `3.0.0`; until then callers should migrate to `knowledgeSearchV2` or
the canonical CLI/MCP capability.
