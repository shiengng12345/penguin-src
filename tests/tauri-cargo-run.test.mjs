import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

// Regression guard for the "cargo run could not determine which binary to
// run" failure that broke `pnpm tauri dev`.
//
// Tauri's dev command shells out to a bare `cargo run` (no `--bin`). Cargo
// only resolves that unambiguously when the crate has exactly one binary
// target, OR `[package].default-run` names one. `src-tauri/src/bin/*.rs`
// files are each their own implicit binary target, so adding one alongside
// `src/main.rs` reintroduces the ambiguity unless `default-run` is set (and
// kept pointed at the real app entrypoint, not just any binary name).
//
// This has no runtime harness for `cargo run` itself here, so — per repo
// convention (see app-update-keeps-packages.test.mjs) — the contract is
// asserted at the source/manifest level instead.

const cargoTomlUrl = new URL("../src-tauri/Cargo.toml", import.meta.url);
const binDirUrl = new URL("../src-tauri/src/bin/", import.meta.url);
const mainRsUrl = new URL("../src-tauri/src/main.rs", import.meta.url);

// Cargo.toml here is a flat, simple manifest (no nested tables inside
// [package], no [[bin]] overrides) — a small regex reader is enough to pin
// the fields this test cares about without pulling in a TOML dependency.
function readPackageField(tomlText, field) {
  const packageSection = tomlText.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  assert.ok(packageSection, "Cargo.toml must have a [package] section");
  const match = packageSection[1].match(
    new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, "m"),
  );
  return match ? match[1] : undefined;
}

test("src-tauri binary target count matches what default-run resolves", async () => {
  const cargoToml = await readFile(cargoTomlUrl, "utf8");
  const packageName = readPackageField(cargoToml, "name");
  assert.ok(packageName, "Cargo.toml [package] must declare a name");

  // Discover every binary target `cargo run` (no --bin) would have to pick
  // between: the implicit src/main.rs binary (named after the package) and
  // every file under src/bin/.
  const binaryNames = [];
  const hasMainRs = await readFile(mainRsUrl, "utf8").then(
    () => true,
    () => false,
  );
  if (hasMainRs) binaryNames.push(packageName);

  const binDirEntries = await readdir(binDirUrl, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of binDirEntries) {
    if (entry.isFile() && entry.name.endsWith(".rs")) {
      binaryNames.push(entry.name.replace(/\.rs$/, ""));
    }
  }

  if (binaryNames.length <= 1) {
    // Only one binary target exists — bare `cargo run` is unambiguous
    // without a default-run key. Nothing further to assert.
    return;
  }

  const defaultRun = readPackageField(cargoToml, "default-run");
  assert.ok(
    defaultRun,
    `src-tauri has ${binaryNames.length} binary targets (${binaryNames.join(", ")}) ` +
      "but no [package].default-run — `cargo run` (what `pnpm tauri dev` shells out to) " +
      "cannot pick one, and `pnpm tauri dev` will fail to launch.",
  );
  assert.ok(
    binaryNames.includes(defaultRun),
    `[package].default-run = "${defaultRun}" does not name any discovered binary target ` +
      `(${binaryNames.join(", ")})`,
  );

  // default-run must resolve to the actual Tauri launcher (src/main.rs),
  // not merely to *some* valid binary name — otherwise `pnpm tauri dev`
  // would start the wrong process without cargo ever erroring.
  assert.equal(
    defaultRun,
    packageName,
    "[package].default-run must point at the src/main.rs binary (named after the package) " +
      "so `pnpm tauri dev` launches the Tauri app, not a helper binary like broker_sim",
  );

  const libName = readPackageField(cargoToml, "name") &&
    (cargoToml.match(/\[lib\][\s\S]*?name\s*=\s*"([^"]+)"/) || [])[1];
  if (hasMainRs && libName) {
    const mainRs = await readFile(mainRsUrl, "utf8");
    assert.match(
      mainRs,
      new RegExp(`${libName}\\s*::\\s*run\\s*\\(`),
      "src/main.rs must call into the app lib's run() — confirms default-run really " +
        "launches the Tauri app rather than a binary that merely happens to share its name",
    );
  }
});
