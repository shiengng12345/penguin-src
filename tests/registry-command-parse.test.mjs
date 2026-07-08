import assert from "node:assert/strict";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Transpile the TS parser module to a temp .mjs and import it (same pattern as
// registry-search-core.test.mjs). The module is a pure function with no imports.
async function loadParser() {
  const source = await readFileP(new URL("../src/lib/registry-command-parse.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const tmpUrl = new URL(`./.tmp-regcmd-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmpUrl, outputText);
  try {
    return (await import(tmpUrl.href)).parseRegistryCommand;
  } finally {
    await unlinkP(tmpUrl);
  }
}
const parseRegistryCommand = await loadParser();

const ECHO_CMD =
  'npm config set //sonatype.client88.me/repository/npm_hosted/:_auth="$(echo -n snsoft-read:snsoft-read123 | base64)"';

test("parses the echo -n user:pass command form", () => {
  const r = parseRegistryCommand(ECHO_CMD, "http");
  assert.deepEqual(r, {
    registryUrl: "http://sonatype.client88.me/repository/npm_hosted/",
    username: "snsoft-read",
    password: "snsoft-read123",
  });
});

test("preserves the current scheme (https)", () => {
  const r = parseRegistryCommand(ECHO_CMD, "https");
  assert.equal(r.registryUrl, "https://sonatype.client88.me/repository/npm_hosted/");
  assert.equal(r.username, "snsoft-read");
});

test("tolerates single quotes and missing 'npm config set' prefix", () => {
  const cmd = "//nexus.example.com/repo/:_auth='$(echo -n alice:secret | base64)'";
  const r = parseRegistryCommand(cmd, "http");
  assert.deepEqual(r, {
    registryUrl: "http://nexus.example.com/repo/",
    username: "alice",
    password: "secret",
  });
});

test("falls back to decoding a literal base64 _auth value (bare .npmrc line)", () => {
  const b64 = Buffer.from("bob:pw123").toString("base64");
  const line = `//nexus.example.com/repo/:_auth=${b64}`;
  const r = parseRegistryCommand(line, "https");
  assert.deepEqual(r, {
    registryUrl: "https://nexus.example.com/repo/",
    username: "bob",
    password: "pw123",
  });
});

test("password containing ':' splits only on the first colon", () => {
  const cmd = "//h/r/:_auth=\"$(echo -n user:pa:ss:word | base64)\"";
  const r = parseRegistryCommand(cmd, "http");
  assert.equal(r.username, "user");
  assert.equal(r.password, "pa:ss:word");
});

test("returns null for a plain registry URL (not a command)", () => {
  assert.equal(parseRegistryCommand("http://sonatype.client88.me/repository/npm_hosted/", "http"), null);
});

test("returns null for empty / non-command input", () => {
  assert.equal(parseRegistryCommand("", "http"), null);
  assert.equal(parseRegistryCommand("just some text", "http"), null);
});

test("returns null when credential has no colon", () => {
  const b64 = Buffer.from("nocolon").toString("base64");
  assert.equal(parseRegistryCommand(`//h/r/:_auth=${b64}`, "http"), null);
});

test("returns null when the base64 value is invalid", () => {
  assert.equal(parseRegistryCommand("//h/r/:_auth=@@@notbase64@@@", "http"), null);
});
