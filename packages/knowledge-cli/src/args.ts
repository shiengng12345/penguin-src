export interface ParsedCliArguments {
  verb: string | undefined;
  flags: string[];
  positional: string[];
  json: boolean;
  optionValue(name: string): string | undefined;
  optionValues(name: string): string[];
  numberOption(name: string): number | undefined;
  error?: { code: "UNKNOWN_OPTION" | "MISSING_OPTION_VALUE"; message: string; option: string };
}

const VALUE_FLAGS = new Set([
  "--against", "--allow-hosts", "--as", "--backup", "--base", "--batch", "--block-id", "--body", "--body-file", "--branch", "--capability-hash", "--class", "--command", "--commit", "--confirm", "--content", "--context-lines", "--contract-version", "--credential-id", "--cursor", "--depth", "--detail", "--doc", "--doc-format", "--document-key", "--end-line", "--env", "--expires-in-ms", "--format", "--from", "--generation", "--header", "--id", "--input", "--into", "--key", "--kind", "--language", "--limit", "--line", "--location", "--managed-by", "--manifest", "--max-attempts", "--max-scanned-bytes", "--method", "--minimum-free-after-bytes", "--mode", "--model", "--name", "--node-token", "--operation-token", "--out", "--out-manifest", "--package", "--parent-token", "--passphrase-env", "--passphrase-fd", "--path", "--persona", "--preview", "--protocol", "--provenance-kind", "--provider", "--query", "--regex-flags", "--repo", "--request", "--results", "--resume-after", "--revision-id", "--schema", "--scope", "--semantic", "--service", "--snapshot", "--start-byte", "--status", "--target", "--title", "--transport", "--type", "--url", "--workspace",
]);

const BOOLEAN_FLAGS = new Set([
  "--allow-fallback", "--allow-partial", "--apply", "--case-insensitive", "--case-sensitive", "--compact", "--direct", "--drain", "--dry-run", "--dsl", "--events-jsonl", "--explain", "--full", "--global", "--handled-only", "--help", "--include-evidence", "--include-excluded-metadata", "--include-generated", "--include-notes", "--include-source", "--include-vendor", "--json", "--legacy-search", "--no-gc", "--progress-events", "--prune", "--revisions", "--save", "--verify", "--version", "--whole-word", "--working-tree",
]);

const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

export function parseCliArguments(argv: string[]): ParsedCliArguments {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional: string[] = [];
  let error: ParsedCliArguments["error"];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const flagName = arg.startsWith("--") ? arg.split("=", 1)[0] : "";
    if (flagName && !KNOWN_FLAGS.has(flagName) && !error) {
      error = { code: "UNKNOWN_OPTION", option: flagName, message: `unknown option ${flagName}` };
    }
    if (VALUE_FLAGS.has(flagName) && !arg.includes("=")) {
      const next = argv[index + 1];
      if ((next === undefined || next.startsWith("--")) && flagName !== "--confirm" && !error) {
        error = { code: "MISSING_OPTION_VALUE", option: flagName, message: `${flagName} requires a value` };
      } else {
        index += 1;
      }
      continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }
  const optionValue = (name: string): string | undefined => {
    const key = `--${name}`;
    const inline = argv.find((arg) => arg.startsWith(`${key}=`));
    if (inline) return inline.slice(key.length + 1);
    const index = argv.indexOf(key);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const optionValues = (name: string): string[] => {
    const key = `--${name}`;
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index].startsWith(`${key}=`)) values.push(argv[index].slice(key.length + 1));
      else if (argv[index] === key && argv[index + 1] !== undefined) values.push(argv[index + 1]);
    }
    return values;
  };
  const numberOption = (name: string): number | undefined => {
    const raw = optionValue(name);
    if (raw == null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return { verb: argv[0], flags, positional, json: flags.includes("--json"), optionValue, optionValues, numberOption, error };
}
