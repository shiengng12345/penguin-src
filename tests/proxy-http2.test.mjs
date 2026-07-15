import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("Rust proxy tries HTTP/2 then falls back to HTTP/1.1 for gRPC-Web", async () => {
  const source = await readFile(new URL("../src-tauri/src/proxy.rs", import.meta.url), "utf8");
  assert.match(source, /application\/grpc-web/);
  assert.match(source, /reqwest::Version::HTTP_2/);
  assert.match(source, /reqwest::Version::HTTP_11/);
  assert.match(source, /grpc_web_request/);
  assert.match(source, /retry/);
});
