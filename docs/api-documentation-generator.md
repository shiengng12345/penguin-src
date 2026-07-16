# Penguin API Documentation Generator

The generator produces an immutable local preview from indexed Knowledge facts, branch/revision trust, Wiki notes, and optional runtime evidence. It never replays a business request to discover behavior.

## CLI

```text
penguin api-doc generate --request request.json --json
penguin api-doc list --query Login --json
penguin api-doc show <preview-id> --format markdown
penguin api-doc diff <preview-id> --against <preview-id> --json
penguin api-doc bind <document-key> --node-token <exact-token> --preview <preview-id>
penguin api-doc unbind <document-key> --node-token <expected-token>
penguin api-doc draft <preview-id> --parent-token <token>
penguin api-doc sync <preview-id>
penguin api-doc repair <document-key>
```

`generate` resolves each repository independently. An explicit commit wins over an explicit branch; otherwise the indexed/live revision is selected. Ambiguous revisions fail closed. Feature/dirty revisions are local previews; canonical publication requires an explicit binding. Runtime evidence is unavailable unless a provider is configured, and that state is rendered as a gap rather than inferred away.

Request and response classes distinguish schema constraints, business outcomes, transport failures, dynamic producers, tests, Wiki facts, and SLS observations. Credentials and bearer tokens are placeholdered in generated examples. `exhaustive`/`bounded` coverage is never claimed when schema, graph, trust, or requested runtime evidence is missing.

## Preview and Lark lifecycle

The preview ID is derived from document identity and the exact revision set. Repeated generation is idempotent; a changed feature preview is diffable and does not create a canonical Lark page automatically. Bind requires an exact node token plus the fetched document ID/revision, so same-title pages are never selected implicitly.

Managed sections carry gray `PENGUIN_API_DOC_BEGIN/END` markers. Sync fetches the full document, verifies marker structure and the last generated hashes, writes one section at a time with revision checks, refetches after every mutation, and only then updates the binding. Human edits, duplicate markers, permission failures, network failures, and partial writes leave the old verified binding intact and create a repairable journal. `repair` refetches first; it does not trust a process exit code.

Drafts are unbound until a human explicitly binds the returned node token. Unbind requires the expected token. No generated document is inserted into Knowledge source facts; the preview remains an immutable artifact with its source revision/evidence references.

## SLS and Wiki evidence

SLS investigation uses the configured target identity (environment, region, project, and logstore), bounded trace/request SQL, per-target failure isolation, and explicit `no_match`/timeout/unauthorized/partial states. Captured evidence is written to a typed sensitive-aware Markdown note and can be reindexed after deleting SQLite. A successful query is evidence of observations, not proof that no other event exists.
