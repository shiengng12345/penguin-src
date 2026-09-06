# Task 3 MCP/CLI parity evidence

- CLI bundle: `/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs`
- MCP bundle: `/Users/shieng/Desktop/Pengvi/packages/mcp/bundle/dist/index.js`
- Node: `/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/node`
- CLI stable wrapper: `/private/var/folders/x4/x9xp0jgd7j16klqg_z3h25wc0000gp/T/pengvi-sandbox-EXkNnb/penguin-task3-home-cJKWlT/.penguin/bin/penguin`
- MCP stable wrapper: `/private/var/folders/x4/x9xp0jgd7j16klqg_z3h25wc0000gp/T/pengvi-sandbox-EXkNnb/penguin-task3-home-cJKWlT/.penguin/bin/penguin-mcp`
- Repository: `FPMS-NT`
- Checks: 17
- Failed: 0
- Target source: `worktree:af30479f2bb95aa8672190ffc14ee56864fdc41affb62528f6956cc0c1f52452`
- Bundle source: `worktree:af30479f2bb95aa8672190ffc14ee56864fdc41affb62528f6956cc0c1f52452`
- Target/bundle source match: `true`
- Worktree state at start: `dirty`
- Worktree digest: `af30479f2bb95aa8672190ffc14ee56864fdc41affb62528f6956cc0c1f52452`
- Included source files: 1235
- Dirty files at start: 379
- Tracked launchers: `scripts/knowledge-cli-launcher.mjs`, `scripts/knowledge-mcp-launcher.mjs`
- Bundle ID (SHA-256 of source identity and exact CLI+MCP+launcher bytes): `c1db33f718707fddb6f1a5fca8376cb4c1878265bf1b8f42293cccb751269605`
- Bundle hashes: {"cli":"5065c5c699eb233d591c9d311b4052d34e6505971c2d500c08b5be82970f902b","mcp":"fc2fb803842ac29b242321f631ec2f9bcef8c54224b735c2cd8ccb1d9c7486af","cliLauncher":"b34aed06ae01631821732e3052621a595cb1743914bcdd40fffe11a8452b2312","mcpLauncher":"4bb6b35b8af12fccd1c99a145d8697257f7576bdb90d16dc83fe36da6340e669"}

## Verdict

PASS: real CLI and MCP process parity checks passed.

## Evidence sidecars

Each sidecar is complete JSON; no evidence is truncated. Paths and temporary-home values are redacted.

### registration-surface
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/01-registration-surface.json`
- Bytes: 351
- SHA-256: `132dceddd438004ef57152c1ab89b49f967a15da607296eb8ca3f7a506326709`
```json
{"fields":["capabilityCount","capabilityHash","duplicateToolIds","duplicateToolNames","extraRegistrations","extraToolIds","extraTools","mcpRegistrationCount","missingRegistrations","missingToolIds","missingTools","schemaMismatches","toolDefinitionCount"]}
```

### source-bundle-provenance
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/02-source-bundle-provenance.json`
- Bytes: 20428
- SHA-256: `fb286fa2b3f3b0eeade022a9173e965ecc7214ad85597e30da523caa8f9b7e78`
```json
{"fields":["bundleCommitMatchesTarget","bundleContentHashes","bundleId","bundleSourceCommit","bundleSourceIdentity","bundleSourceMatchesTarget","bundleSourceTree","dirtyFiles","includedFileCount","runtimeBuildId","runtimeManifestBuildId","sourceCommit","sourceIdentity","sourceTree","targetCommit","targetSourceIdentity","trackedLauncherInputs","verification","worktreeDigest","worktreeState"]}
```

### cli-capabilities-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/03-cli-capabilities-process.json`
- Bytes: 195315
- SHA-256: `960bb3174b4a5df58597fd2c4412d0600df31bb4bf0f1c0c1bfacb17b771262e`
```json
{"fields":["capabilities","process"]}
```

### cli-endpoints-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/04-cli-endpoints-process.json`
- Bytes: 10485
- SHA-256: `a8639507ae31bb0cc4d13eaec83808f603ac6d1a020564b7235dd79f3af4cdfa`
```json
{"fields":["args","durationMs","exitCode","kind","signal","stderr","stdout"],"exitCode":0,"stdoutBytes":9615,"stderrBytes":0}
```

### mcp-initialize-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/05-mcp-initialize-process.json`
- Bytes: 2891
- SHA-256: `839359907051425c8cc6ce18c2a3325a06c8ed0ba088da9c137c41f568b35fe3`
```json
{"fields":["args","command","exitCode","exitSignal","instructions","label","messages","pid","protocolLines","response","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":551,"stderrBytes":0}
```

### mcp-tools-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/06-mcp-tools-process.json`
- Bytes: 314283
- SHA-256: `603a5bb52f36170a03a4093a7c74fb52a7d2d078912047bd5bfd36b5511ffc29`
```json
{"fields":["args","command","duplicateListedToolIds","duplicateListedToolNames","exitCode","exitSignal","extraListedToolIds","extraListedTools","label","listedTools","messages","missingListedToolIds","missingListedTools","pid","protocolLines","response","spawnError","stderr","stdout","toolMismatches"],"spawnError":null,"stdoutBytes":60694,"stderrBytes":0}
```

### mcp-capabilities-schema-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/07-mcp-capabilities-schema-process.json`
- Bytes: 1425918
- SHA-256: `a6af356b2ea4a8859dc991f177b1a8be2772fa736fbece743cfa7ea55b0989dd`
```json
{"fields":["args","command","exitCode","exitSignal","extraCliCapabilities","extraMcpCapabilities","extraMcpRegistrations","label","manifestEqual","manifestMismatches","messages","missingCliCapabilities","missingMcpCapabilities","missingMcpRegistrations","pid","protocolLines","registrationMismatches","response","spawnError","stderr","stdout","structured"],"spawnError":null,"stdoutBytes":323812,"stderrBytes":0}
```

### mcp-health-generation-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/08-mcp-health-generation-process.json`
- Bytes: 1083010
- SHA-256: `fa9e58f8f0422837d67745c527015590790541bb2532705187ec9fa1f2b65204`
```json
{"fields":["args","command","exitCode","exitSignal","generation","label","messages","pid","protocolLines","response","spawnError","stderr","stdout","structured"],"spawnError":null,"stdoutBytes":328502,"stderrBytes":0}
```

### mcp-endpoints-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/09-mcp-endpoints-process.json`
- Bytes: 1180130
- SHA-256: `cf2ae4e8a3ac9467229cc1fe6c0d33dedb241af669218a3141df32017455168a`
```json
{"fields":["args","command","exitCode","exitSignal","label","messages","pid","protocolLines","response","spawnError","stderr","stdout","structured"],"spawnError":null,"stdoutBytes":350655,"stderrBytes":217}
```

### endpoint-direct-filter-parity-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/10-endpoint-direct-filter-parity-process.json`
- Bytes: 1193621
- SHA-256: `8755f30c9fb580aa7e35260a3267466ecbfddcf512270558c5340d78bdb39665`
```json
{"fields":["args","cli","cliStructured","command","exitCode","exitSignal","filter","label","mcpResponse","mcpStructured","messages","pid","protocolLines","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":350655,"stderrBytes":217}
```

### endpoint-identity-process
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/11-endpoint-identity-process.json`
- Bytes: 3441494
- SHA-256: `ee1b09047a442e3848d18bd3bfd437a8a15ad1157c852a433f6732a65ef14049`
```json
{"fields":["args","cliEndpoint","cliIdentityChecks","command","exitCode","exitSignal","forms","label","mcpEndpoint","mcpIdentityChecks","messages","pid","protocolLines","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":839317,"stderrBytes":868}
```

### dynamic-cli-id-to-mcp-flow
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/12-dynamic-cli-id-to-mcp-flow.json`
- Bytes: 3237857
- SHA-256: `c4928a0fdde886d61ebb9bc6a81d5c2f9606ec5dea4361203b5540898e65f719`
```json
{"fields":["args","cli","cliSuccess","command","exitCode","exitSignal","label","mcp","mcpSuccess","messages","normalizedCli","normalizedMcp","pid","protocolLines","spawnError","stderr","stdout","target"],"spawnError":null,"stdoutBytes":937049,"stderrBytes":868}
```

### dynamic-mcp-id-to-cli-flow
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/13-dynamic-mcp-id-to-cli-flow.json`
- Bytes: 3556060
- SHA-256: `52fed0c22bdd328c43c59cda1edb9188bbcda446c6fbd3d6c14e43a2a028e247`
```json
{"fields":["args","cli","cliSuccess","command","exitCode","exitSignal","label","mcp","mcpSuccess","messages","normalizedCli","normalizedMcp","pid","protocolLines","spawnError","stderr","stdout","target"],"spawnError":null,"stdoutBytes":1034781,"stderrBytes":868}
```

### normalized-error-envelope
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/14-normalized-error-envelope.json`
- Bytes: 3382574
- SHA-256: `7f48178f698ee671d770bfb1d3c0a611245f2097a99fc349462ba60eac7b4fde`
```json
{"fields":["args","cli","command","exitCode","exitSignal","label","mcp","messages","normalizedCliError","normalizedMcpError","pid","protocolLines","spawnError","stderr","stdout","target"],"spawnError":null,"stdoutBytes":1035694,"stderrBytes":1086}
```

### scope-error-envelope
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/15-scope-error-envelope.json`
- Bytes: 3386952
- SHA-256: `1790006882e35dc3f69c390c5689aeaa8d4a1342ee0f3201a77c4d2ef36268ac`
```json
{"fields":["args","branch","cli","command","exitCode","exitSignal","label","mcp","messages","normalizedCliError","normalizedMcpError","pid","protocolLines","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":1036788,"stderrBytes":1086}
```

### unsupported-error-envelope
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/16-unsupported-error-envelope.json`
- Bytes: 3388873
- SHA-256: `5f869b8a31921879e3fd95b953ca155283919b0ec1d5b3b911018ff27b442299`
```json
{"fields":["args","cli","command","exitCode","exitSignal","label","mcp","messages","normalizedCliError","normalizedMcpError","pid","protocolLines","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":1037655,"stderrBytes":1086}
```

### generic-error-envelope
- Sidecar: `/Users/shieng/Desktop/Pengvi/.superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-evidence/17-generic-error-envelope.json`
- Bytes: 3390413
- SHA-256: `4ce487effd33dff7681b962db892dd139dac32a3423620b7e920865ff5aef7de`
```json
{"fields":["args","cli","command","exitCode","exitSignal","label","mcp","messages","normalizedCliError","normalizedMcpError","pid","protocolLines","spawnError","stderr","stdout"],"spawnError":null,"stdoutBytes":1038273,"stderrBytes":1086}
```
