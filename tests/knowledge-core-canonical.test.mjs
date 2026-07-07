import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, sha256Hex } from "../packages/knowledge-core/dist/index.js";

test("canonicalJson sorts object keys recursively", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
  const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
});

test("canonicalJson drops undefined properties, keeps null", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("canonicalJson handles primitives and unicode", () => {
  assert.equal(canonicalJson("中文"), JSON.stringify("中文"));
  assert.equal(canonicalJson(1.5), "1.5");
  assert.equal(canonicalJson(true), "true");
});

test("sha256Hex is stable", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
