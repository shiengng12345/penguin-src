const VALUE_FLAGS = new Set(["--branch", "--commit", "--snapshot", "--depth", "--limit", "--repo", "--workspace", "--path", "--language", "--kind", "--target", "--status", "--from", "--request", "--document-key", "--query", "--name", "--format", "--against", "--mode", "--semantic", "--regex-flags", "--max-scanned-bytes", "--cursor", "--out", "--input", "--into", "--base", "--line", "--end-line", "--start-byte", "--context-lines", "--class", "--capability-hash", "--type", "--location", "--allow-hosts", "--persona", "--id", "--results", "--confirm", "--passphrase-env", "--passphrase-fd", "--batch", "--resume-after", "--credential-id", "--schema"]);
export function parseCliArguments(argv) {
    const flags = argv.filter((arg) => arg.startsWith("--"));
    const positional = [];
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (VALUE_FLAGS.has(arg)) {
            index += 1;
            continue;
        }
        if (!arg.startsWith("--"))
            positional.push(arg);
    }
    const optionValue = (name) => {
        const key = `--${name}`;
        const inline = argv.find((arg) => arg.startsWith(`${key}=`));
        if (inline)
            return inline.slice(key.length + 1);
        const index = argv.indexOf(key);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const optionValues = (name) => {
        const key = `--${name}`;
        const values = [];
        for (let index = 0; index < argv.length; index += 1) {
            if (argv[index].startsWith(`${key}=`))
                values.push(argv[index].slice(key.length + 1));
            else if (argv[index] === key && argv[index + 1] !== undefined)
                values.push(argv[index + 1]);
        }
        return values;
    };
    const numberOption = (name) => {
        const raw = optionValue(name);
        if (raw == null)
            return undefined;
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    return { verb: argv[0], flags, positional, json: flags.includes("--json"), optionValue, optionValues, numberOption };
}
//# sourceMappingURL=args.js.map