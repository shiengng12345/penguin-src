import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// curl-parser.ts has no external imports — we can transpile and import it
// directly via a data URL, no module mocking needed.
async function loadCurlParserModule() {
  const source = await readFile(
    new URL("../src/lib/curl-parser.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("parseCurl: basic GET with just URL", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl("curl https://api.example.com/users");
  assert.ok(result);
  assert.equal(result.url, "https://api.example.com/users");
  assert.equal(result.method, "GET");
  assert.deepEqual(result.headers, {});
  assert.equal(result.body, "");
});

test("parseCurl: POST with -X flag", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl("curl -X POST https://api.example.com/users");
  assert.ok(result);
  assert.equal(result.method, "POST");
  assert.equal(result.url, "https://api.example.com/users");
});

test("parseCurl: implicit POST when -d body is present", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(`curl https://api.example.com/users -d 'name=alice'`);
  assert.ok(result);
  assert.equal(result.method, "POST");
  assert.equal(result.body, "name=alice");
});

test("parseCurl: single -H header parses name/value", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(
    `curl https://api.example.com/users -H 'Authorization: Bearer abc123'`,
  );
  assert.ok(result);
  assert.equal(result.headers["Authorization"], "Bearer abc123");
});

test("parseCurl: multiple -H / --header preserves key case", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(
    `curl https://api.example.com -H 'X-Trace-Id: 42' --header 'content-type: application/json'`,
  );
  assert.ok(result);
  assert.equal(result.headers["X-Trace-Id"], "42");
  assert.equal(result.headers["content-type"], "application/json");
  // Both keys preserved verbatim — case NOT normalized.
  assert.ok(!("X-trace-id" in result.headers));
});

test("parseCurl: -d / --data / --data-raw / --data-binary all populate body", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const dShort = parseCurl(`curl https://api.example.com -d 'a=1'`);
  const dLong = parseCurl(`curl https://api.example.com --data 'b=2'`);
  const dRaw = parseCurl(`curl https://api.example.com --data-raw 'c=3'`);
  const dBin = parseCurl(`curl https://api.example.com --data-binary 'd=4'`);
  assert.equal(dShort?.body, "a=1");
  assert.equal(dLong?.body, "b=2");
  assert.equal(dRaw?.body, "c=3");
  assert.equal(dBin?.body, "d=4");
});

test("parseCurl: JSON body is pretty-printed", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(
    `curl https://api.example.com -d '{"name":"alice","age":30}'`,
  );
  assert.ok(result);
  assert.equal(
    result.body,
    `{\n  "name": "alice",\n  "age": 30\n}`,
  );
});

test("parseCurl: non-JSON body left as-is", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(`curl https://api.example.com -d 'name=alice&age=30'`);
  assert.ok(result);
  assert.equal(result.body, "name=alice&age=30");
});

test("parseCurl: multi-line input with backslash continuation", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const input = [
    "curl https://api.example.com/users \\",
    "  -X POST \\",
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"ok":true}'`,
  ].join("\n");
  const result = parseCurl(input);
  assert.ok(result);
  assert.equal(result.url, "https://api.example.com/users");
  assert.equal(result.method, "POST");
  assert.equal(result.headers["Content-Type"], "application/json");
  assert.equal(result.body, `{\n  "ok": true\n}`);
});

test("parseCurl: $-prefixed body ($'...') sigil is stripped", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(
    `curl https://api.example.com --data $'{"x":1}'`,
  );
  assert.ok(result);
  assert.equal(result.body, `{\n  "x": 1\n}`);
});

test("parseCurl: input not starting with curl returns null", async () => {
  const { parseCurl } = await loadCurlParserModule();
  assert.equal(parseCurl("wget https://api.example.com"), null);
  assert.equal(parseCurl("https://api.example.com"), null);
  assert.equal(parseCurl(""), null);
});

test("parseCurl: no URL returns null", async () => {
  const { parseCurl } = await loadCurlParserModule();
  assert.equal(parseCurl("curl -X POST"), null);
  assert.equal(parseCurl("curl"), null);
});

test("parseCurl: --compressed / -k / -L / -s / -v flags are silently ignored", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const result = parseCurl(
    `curl --compressed -k -L -s -v https://api.example.com/users`,
  );
  assert.ok(result);
  assert.equal(result.url, "https://api.example.com/users");
  assert.equal(result.method, "GET");
  assert.deepEqual(result.headers, {});
});

test("splitUrlForKb: standard URL → baseUrl + path with query", async () => {
  const { splitUrlForKb } = await loadCurlParserModule();
  const result = splitUrlForKb("https://api.example.com/v1/users?limit=10&sort=asc");
  assert.equal(result.baseUrl, "https://api.example.com");
  assert.equal(result.path, "/v1/users?limit=10&sort=asc");
});

test("splitUrlForKb: invalid URL → empty baseUrl, full string as path", async () => {
  const { splitUrlForKb } = await loadCurlParserModule();
  const result = splitUrlForKb("not a real url");
  assert.equal(result.baseUrl, "");
  assert.equal(result.path, "not a real url");
});

test("getHeader: exact case match returns value", async () => {
  const { getHeader } = await loadCurlParserModule();
  const headers = { "Content-Type": "application/json", "X-Trace-Id": "42" };
  assert.equal(getHeader(headers, "Content-Type"), "application/json");
  assert.equal(getHeader(headers, "X-Trace-Id"), "42");
});

test("getHeader: case-insensitive lookup", async () => {
  const { getHeader } = await loadCurlParserModule();
  const headers = { "Content-Type": "application/json" };
  assert.equal(getHeader(headers, "content-type"), "application/json");
  assert.equal(getHeader(headers, "CONTENT-TYPE"), "application/json");
  assert.equal(getHeader(headers, "cOnTeNt-TyPe"), "application/json");
});

test("getHeader: missing header returns empty string", async () => {
  const { getHeader } = await loadCurlParserModule();
  const headers = { "Content-Type": "application/json" };
  assert.equal(getHeader(headers, "Authorization"), "");
  assert.equal(getHeader({}, "anything"), "");
});

test("ANSI-C $'...' body: 5-null-byte gRPC-Web frame → hex binary body", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const parsed = parseCurl(
    "curl 'https://x.me/svc/M' -H 'content-type: application/grpc-web+proto' --data-raw $'\\x00\\x00\\x00\\x00\\x00'",
  );
  assert.equal(parsed.bodyEncoding, "hex");
  assert.equal(parsed.body, "0000000000");
  assert.equal(parsed.method, "POST");
  // content-type must survive — it's the whole point of the grpc-web send.
  assert.equal(parsed.headers["content-type"], "application/grpc-web+proto");
});

test("ANSI-C $'...' body: printable escapes decode to text (not hex)", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const parsed = parseCurl("curl 'https://x.me' --data-raw $'a\\tb\\n'");
  assert.equal(parsed.bodyEncoding, undefined);
  assert.equal(parsed.body, "a\tb\n");
});

test("ANSI-C $'...' body: mixed binary payload → hex", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const parsed = parseCurl("curl 'https://x.me' --data-binary $'\\x01\\x02\\xff'");
  assert.equal(parsed.bodyEncoding, "hex");
  assert.equal(parsed.body, "0102ff");
});

test("plain single-quoted body still parses as text (no ANSI-C)", async () => {
  const { parseCurl } = await loadCurlParserModule();
  const parsed = parseCurl("curl 'https://x.me' --data '{\"a\":1}'");
  assert.equal(parsed.bodyEncoding, undefined);
  assert.equal(JSON.parse(parsed.body).a, 1);
});
