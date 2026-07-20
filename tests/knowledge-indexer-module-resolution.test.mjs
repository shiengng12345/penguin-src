import assert from "node:assert/strict";
import test from "node:test";
import { extractSymbols } from "../packages/knowledge-indexer/dist/index.js";

test("module fixtures preserve barrel/default re-export and language identities", async () => {
  const barrel = await extractSymbols({ lang: "ts", relPath: "src/index.ts", source: 'export { default as User } from "./user";\nexport * from "./admin";' });
  assert.deepEqual(barrel.fileImports.sort(), ["./admin", "./user"]);
  assert.equal(barrel.refs.filter((ref) => ref.kind === "import").length, 2);

  const pathAlias = await extractSymbols({ lang: "ts", relPath: "src/api.ts", source: 'import User from "@/models/user";\nexport default function load() { return User; }' });
  assert.ok(pathAlias.refs.some((ref) => ref.kind === "import" && ref.rawName === "@/models/user"));

  const rust = await extractSymbols({ lang: "rust", relPath: "src/lib.rs", source: "mod auth;\nuse crate::auth::Login;" });
  const go = await extractSymbols({ lang: "go", relPath: "api/server.go", source: "package api\ntype Server struct{}\nfunc (s Server) Handle() {}" });
  const java = await extractSymbols({ lang: "java", relPath: "src/C.java", source: "package com.example; class C { void m() {} }" });
  const python = await extractSymbols({ lang: "python", relPath: "src/c.py", source: "import pkg.mod\nclass C:\n  def m(self): pass" });
  assert.ok(rust.refs.some((ref) => ref.kind === "import" && ref.rawName.includes("crate::auth")));
  assert.ok(go.symbols.some((symbol) => symbol.qualifiedName.includes("Handle")));
  assert.ok(java.symbols.some((symbol) => symbol.qualifiedName === "C.m"));
  assert.ok(python.symbols.some((symbol) => symbol.qualifiedName === "C.m"));
});
