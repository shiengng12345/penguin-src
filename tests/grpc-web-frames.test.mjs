import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadModule() {
  const source = await readFile(
    new URL("../packages/core/src/grpc-web-frames.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

// Build one gRPC-Web frame: [flag][4B big-endian len][data].
function frame(flag, data) {
  const body = Uint8Array.from(data);
  const out = new Uint8Array(5 + body.length);
  out[0] = flag;
  out[1] = (body.length >>> 24) & 0xff;
  out[2] = (body.length >>> 16) & 0xff;
  out[3] = (body.length >>> 8) & 0xff;
  out[4] = body.length & 0xff;
  out.set(body, 5);
  return out;
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
const textBytes = (s) => Array.from(new TextEncoder().encode(s));
const trailerFrame = (text) => frame(0x80, textBytes(text));

test("empty-message frame: one message, zero-length data", async () => {
  const { parseGrpcWebFrames, parseGrpcTrailers } = await loadModule();
  const frames = parseGrpcWebFrames(frame(0x00, []));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].trailer, false);
  assert.equal(frames[0].data.length, 0);
  assert.equal(parseGrpcTrailers(frames), null);
});

test("data + trailer: message bytes preserved, status/message parsed", async () => {
  const { parseGrpcWebFrames, parseGrpcTrailers } = await loadModule();
  const msg = frame(0x00, [0x0a, 0x02, 0x68, 0x69]); // field1 = "hi"
  const trailer = trailerFrame("grpc-status:0\r\ngrpc-message:OK\r\n");
  const frames = parseGrpcWebFrames(concat(msg, trailer));
  assert.equal(frames.length, 2);
  assert.equal(frames.filter((f) => !f.trailer).length, 1);
  const t = parseGrpcTrailers(frames);
  assert.equal(t.status, 0);
  assert.equal(t.message, "OK");
});

test("trailers-only response (0 messages)", async () => {
  const { parseGrpcWebFrames, parseGrpcTrailers } = await loadModule();
  const frames = parseGrpcWebFrames(trailerFrame("grpc-status:16\r\ngrpc-message:Your login has expired."));
  assert.equal(frames.filter((f) => !f.trailer).length, 0);
  const t = parseGrpcTrailers(frames);
  assert.equal(t.status, 16);
  assert.equal(t.message, "Your login has expired.");
});

test("percent-encoded grpc-message is decoded", async () => {
  const { parseGrpcWebFrames, parseGrpcTrailers } = await loadModule();
  const t = parseGrpcTrailers(parseGrpcWebFrames(trailerFrame("grpc-status:3\r\ngrpc-message:bad%20arg")));
  assert.equal(t.message, "bad arg");
});

test("multiple data frames", async () => {
  const { parseGrpcWebFrames } = await loadModule();
  const frames = parseGrpcWebFrames(concat(frame(0, [1]), frame(0, [2, 3]), frame(0, [4])));
  assert.equal(frames.length, 3);
  assert.deepEqual(Array.from(frames[1].data), [2, 3]);
});

test("malformed: length exceeds body throws", async () => {
  const { parseGrpcWebFrames, GrpcWebParseError } = await loadModule();
  const bad = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x01, 0x02]); // claims 16 bytes, has 2
  assert.throws(() => parseGrpcWebFrames(bad), GrpcWebParseError);
});

test("malformed: truncated header throws", async () => {
  const { parseGrpcWebFrames, GrpcWebParseError } = await loadModule();
  assert.throws(() => parseGrpcWebFrames(Uint8Array.from([0x00, 0x00, 0x00])), GrpcWebParseError);
});

test("compressed frame is rejected", async () => {
  const { parseGrpcWebFrames, GrpcWebParseError } = await loadModule();
  assert.throws(() => parseGrpcWebFrames(frame(0x01, [1, 2, 3])), GrpcWebParseError);
});

test("schema-less decode: string + varint by field number", async () => {
  const { decodeUnknownMessage } = await loadModule();
  // field1 (len-delim) = "hi"; field2 (varint) = 401
  const view = decodeUnknownMessage(Uint8Array.from([0x0a, 0x02, 0x68, 0x69, 0x10, 0x91, 0x03]));
  assert.equal(view["1"][0].wireType, 2);
  assert.equal(view["1"][0].lengthDelimited.utf8, "hi");
  assert.equal(view["2"][0].wireType, 0);
  assert.equal(view["2"][0].varint.unsigned, "401");
});

test("schema-less decode: repeated field preserved as array; binary stays bytes-only", async () => {
  const { decodeUnknownMessage } = await loadModule();
  // field1 varint 1, field1 varint 2 (repeated), field3 len-delim = [0xff,0xfe] (invalid utf8)
  const view = decodeUnknownMessage(Uint8Array.from([0x08, 0x01, 0x08, 0x02, 0x1a, 0x02, 0xff, 0xfe]));
  assert.equal(view["1"].length, 2);
  assert.equal(view["1"][0].varint.bool, true);
  assert.equal(view["3"][0].lengthDelimited.utf8, null); // not valid utf8 → no text candidate
  assert.equal(typeof view["3"][0].lengthDelimited.base64, "string");
});

test("schema-less decode: nested message detected as candidate", async () => {
  const { decodeUnknownMessage } = await loadModule();
  // field1 len-delim wrapping a sub-message { field1 varint 42 } = [0x08, 0x2a]
  const view = decodeUnknownMessage(Uint8Array.from([0x0a, 0x02, 0x08, 0x2a]));
  assert.ok(view["1"][0].lengthDelimited.nested, "expected nested candidate");
  assert.equal(view["1"][0].lengthDelimited.nested["1"][0].varint.unsigned, "42");
});

// ---- Connect protocol helpers -----------------------------------------------

test("classify: gRPC-Web content-types on any HTTP status", async () => {
  const { classifyProtoResponse } = await loadModule();
  assert.equal(classifyProtoResponse("application/grpc-web+proto", 200), "grpc-web");
  assert.equal(classifyProtoResponse("application/grpc-web", 500), "grpc-web");
  assert.equal(classifyProtoResponse("Application/GRPC-Web+Proto", 200), "grpc-web");
});

test("classify: bare proto is decodable only on HTTP 200", async () => {
  const { classifyProtoResponse } = await loadModule();
  assert.equal(classifyProtoResponse("application/proto", 200), "proto-unary");
  // Non-200 proto bodies are error payloads, not messages (Connect errors are
  // application/json, so this is a non-Connect server's error).
  assert.equal(classifyProtoResponse("application/proto", 500), null);
  assert.equal(classifyProtoResponse("application/proto", 404), null);
});

test("classify: content-type parameters are ignored", async () => {
  const { classifyProtoResponse } = await loadModule();
  assert.equal(classifyProtoResponse("application/proto; charset=utf-8", 200), "proto-unary");
});

test("classify: connect streaming envelope content-type", async () => {
  const { classifyProtoResponse } = await loadModule();
  assert.equal(classifyProtoResponse("application/connect+proto", 200), "connect-stream");
});

test("classify: everything else stays out of the lens", async () => {
  const { classifyProtoResponse } = await loadModule();
  assert.equal(classifyProtoResponse("application/json", 200), null);
  assert.equal(classifyProtoResponse("text/html", 200), null);
  assert.equal(classifyProtoResponse(undefined, 200), null);
  assert.equal(classifyProtoResponse(null, 200), null);
  assert.equal(classifyProtoResponse("", 200), null);
});

test("connect end-stream: error code and message parsed", async () => {
  const { parseConnectEndStream } = await loadModule();
  const end = parseConnectEndStream(
    new TextEncoder().encode('{"error":{"code":"unauthenticated","message":"token expired"}}'),
  );
  assert.deepEqual(end.error, { code: "unauthenticated", message: "token expired" });
});

test("connect end-stream: successful termination has no error", async () => {
  const { parseConnectEndStream } = await loadModule();
  assert.equal(parseConnectEndStream(new TextEncoder().encode("{}")).error, null);
  assert.equal(parseConnectEndStream(new TextEncoder().encode('{"metadata":{}}')).error, null);
});

test("connect end-stream: malformed payload degrades, never throws", async () => {
  const { parseConnectEndStream } = await loadModule();
  const end = parseConnectEndStream(new TextEncoder().encode("not json"));
  assert.equal(end.error, null);
  assert.equal(end.raw, "not json");
  // Non-string code falls back to "unknown" rather than leaking a non-string.
  const weird = parseConnectEndStream(new TextEncoder().encode('{"error":{"code":3,"message":"x"}}'));
  assert.equal(weird.error.code, "unknown");
});

test("connect stream: end-stream frame (0x02) splits from message frames", async () => {
  const { parseGrpcWebFrames, parseConnectEndStream, decodeUnknownMessage, CONNECT_END_STREAM_FLAG } =
    await loadModule();
  const msg = frame(0x00, [0x08, 0x2a]); // field1 varint 42
  const end = frame(CONNECT_END_STREAM_FLAG, textBytes('{"error":{"code":"internal","message":"boom"}}'));
  const frames = parseGrpcWebFrames(concat(msg, end));
  assert.equal(frames.length, 2);
  const endFrame = frames.find((f) => (f.flag & CONNECT_END_STREAM_FLAG) !== 0);
  assert.ok(endFrame, "end-stream frame found by flag");
  assert.equal(endFrame.trailer, false, "0x02 is not the gRPC-Web trailer bit");
  assert.equal(parseConnectEndStream(endFrame.data).error.code, "internal");
  const messages = frames.filter((f) => (f.flag & CONNECT_END_STREAM_FLAG) === 0 && !f.trailer);
  assert.equal(messages.length, 1);
  assert.equal(decodeUnknownMessage(messages[0].data)["1"][0].varint.unsigned, "42");
});

test("connect unary: bare body decodes without any framing", async () => {
  const { decodeUnknownMessage } = await loadModule();
  // No 5-byte envelope — the whole body is the message (field1 = "hi").
  const view = decodeUnknownMessage(Uint8Array.from([0x0a, 0x02, 0x68, 0x69]));
  assert.equal(view["1"][0].lengthDelimited.utf8, "hi");
  // And an empty body is a valid empty message.
  assert.deepEqual(decodeUnknownMessage(Uint8Array.from([])), {});
});
