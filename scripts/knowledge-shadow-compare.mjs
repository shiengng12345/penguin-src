import { readFileSync } from "node:fs";
const [penguinPath, externalPath] = process.argv.slice(2);
if (!penguinPath || !externalPath) { console.error("usage: node scripts/knowledge-shadow-compare.mjs <penguin.jsonl> <external.jsonl>"); process.exit(2); }
const read = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const penguin = new Map(read(penguinPath).map((row) => [row.id, row]));
const external = new Map(read(externalPath).map((row) => [row.id, row]));
const ids = new Set([...penguin.keys(), ...external.keys()]);
const results = [...ids].sort().map((id) => { const p = penguin.get(id); const e = external.get(id); const pLocators = JSON.stringify(p?.locators ?? []); const eLocators = JSON.stringify(e?.locators ?? []); return { id, classification: p && e ? (pLocators === eLocators ? "both_correct" : "unverifiable") : p ? "penguin_only_correct" : "external_only_correct" }; });
const gaps = results.filter((row) => row.classification === "external_only_correct").map((row) => ({ code: "external_only_correct", id: row.id, reproduction: `replay shadow case ${row.id} with the frozen corpus and compare normalized locators` }));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results, gaps, externalOnlyCorrect: gaps.length }, null, 2));
