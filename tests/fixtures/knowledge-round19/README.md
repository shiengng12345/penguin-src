# Round 19 knowledge closure fixtures

Round 19 is an immutable, deterministic acceptance gate for 95-100% knowledge closure.

## Structure

- **expected-contract.json**: frozen expected values for contract identity (buildId placeholder, capabilityHash placeholder, schemaVersion, contractVersion)
- **deterministic-targets.json**: (future) frozen target selections for reproducible test runs

## Test runner

`scripts/knowledge-round19-acceptance.mjs` is the canonical runner. It validates:

1. Contract identity (G0)
2. Basic operations with frozen assertions (G1-G12)
3. Deterministic target selection after concept queries
4. MCP/CLI parity when MCP is available

## Immutability

These fixtures are frozen. Do not modify Round 19 scenarios or expected values. Create Round 20 for new requirements.

## Usage

```bash
# Run full acceptance with MCP and CLI
pnpm knowledge:round19:acceptance

# Run fixture validation only
pnpm knowledge:round19:acceptance -- --fixtures-only

# Run in gate mode (exit 1 on any failure)
pnpm knowledge:round19:acceptance -- --gate
```
