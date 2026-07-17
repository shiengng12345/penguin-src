# Markdown vault and Obsidian

Markdown files remain the source of truth for notes. YAML frontmatter becomes properties; `[[wikilink]]`, anchors and embeds are indexed as link facts. Reindexing rebuilds the database from files, so deleting a note file prunes its index entry. Sensitive notes must be marked and are not exposed to AI/MCP reads.

External local vaults are explicit sources:

```bash
penguin source register --type markdown_directory --location /path/to/vault --json
penguin source sync <source-id> --json
```

The sync creates a revision-scoped source corpus, preserves the previous
revision, and makes Markdown/Canvas content available through the same exact,
path and source evidence lanes. URL/OpenAPI sources remain network-gated and
are not fetched implicitly. External content is untrusted and must not be
treated as verified business truth without evidence review.
