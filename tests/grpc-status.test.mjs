import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadGrpcStatusModule() {
  const source = await readFile(new URL("../src/lib/grpc-status.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

async function loadGrpcJsonModule() {
  const source = await readFile(new URL("../packages/core/src/grpc-json.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

async function loadGrpcWebDebugModule() {
  const source = await readFile(new URL("../packages/core/src/grpc-web-debug.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("summarizes gRPC 14 HTTP 504 as unavailable gateway timeout", async () => {
  const { formatGrpcStatusBadgeLabel, summarizeGrpcStatusResponse } = await loadGrpcStatusModule();

  const summary = summarizeGrpcStatusResponse({
    status: "gRPC 14",
    statusCode: 200,
    body: JSON.stringify({ code: 14, message: "HTTP 504" }),
    headers: {
      "grpc-status": "14",
      "grpc-message": "HTTP 504",
    },
    duration: 60135,
  });

  assert.equal(summary?.title, "UNAVAILABLE (14)");
  assert.equal(summary?.transport, "HTTP 504 Gateway Timeout");
  assert.equal(summary?.retryable, true);
  assert.match(summary?.explanation ?? "", /service is unavailable/i);
  assert.match(summary?.hint ?? "", /upstream service did not respond/i);
  assert.equal(formatGrpcStatusBadgeLabel(summary), "gRPC UNAVAILABLE (14)");
});

test("summarizes gRPC 12 as method not implemented", async () => {
  const { summarizeGrpcStatusResponse } = await loadGrpcStatusModule();

  const summary = summarizeGrpcStatusResponse({
    status: "gRPC 12",
    statusCode: 200,
    body: JSON.stringify({ code: 12, message: "Method not found" }),
    headers: {},
    duration: 42,
  });

  assert.equal(summary?.title, "UNIMPLEMENTED (12)");
  assert.equal(summary?.retryable, false);
  assert.match(summary?.explanation ?? "", /not implemented/i);
  assert.match(summary?.hint ?? "", /selected method/i);
});

test("ResponsePanel renders the readable gRPC status summary", async () => {
  const source = await readFile(new URL("../src/components/request/ResponsePanel.tsx", import.meta.url), "utf8");

  assert.match(source, /summarizeGrpcStatusResponse\(tab\.response\)/);
  assert.match(source, /Error details/);
});

test("ResponsePanel renders response bodies as a contained code viewer", async () => {
  const source = await readFile(new URL("../src/components/request/ResponsePanel.tsx", import.meta.url), "utf8");

  assert.match(source, /data-response-code-surface/);
  assert.match(source, /bg-background\/95/);
  assert.match(source, /whitespace-pre/);
  assert.match(source, /min-w-max/);
  assert.doesNotMatch(source, /whitespace-pre-wrap break-all/);
});

test("ResponsePanel keeps gRPC headers compact with an explicit expand-all action", async () => {
  const source = await readFile(new URL("../src/components/request/ResponsePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /showAllHeaders/);
  assert.match(source, /Show all headers/);
  assert.match(source, /x-penguin-http-version/);
  assert.match(source, /x-penguin-id/);
});

test("normalizes proto enum strings through the generated request fromJson", async () => {
  const { normalizeGrpcJsonBody } = await loadGrpcJsonModule();
  const requestType = {
    fromJson(value) {
      if (value.game === "A") return { ...value, game: 1 };
      if (typeof value.game === "number") return value;
      throw new Error("cannot decode enum sample.Game from JSON");
    },
  };

  assert.deepEqual(normalizeGrpcJsonBody({ game: "A" }, requestType), { game: 1 });
  assert.deepEqual(normalizeGrpcJsonBody({ game: 1 }, requestType), { game: 1 });
});

test("wraps invalid proto enum strings with a readable request body error", async () => {
  const { normalizeGrpcJsonBody } = await loadGrpcJsonModule();
  const requestType = {
    fromJson() {
      throw new Error("cannot decode enum sample.Game from JSON: \"BAD\"");
    },
  };

  assert.throws(
    () => normalizeGrpcJsonBody({ game: "BAD" }, requestType),
    /Request body does not match proto schema.*sample\.Game/s,
  );
});

test("does not silently discard unknown proto request fields", async () => {
  const { normalizeGrpcJsonBody } = await loadGrpcJsonModule();
  let receivedOptions;
  const requestType = {
    fromJson(value, options) {
      receivedOptions = options;
      if (options?.ignoreUnknownFields === false && "bogusField" in value) {
        throw new Error("unknown field bogusField");
      }
      return value;
    },
  };

  assert.throws(
    () => normalizeGrpcJsonBody({ bogusField: true }, requestType),
    /unknown field bogusField/,
  );
  assert.deepEqual(receivedOptions, { ignoreUnknownFields: false });
});

test("gRPC-Web client sends the normalized proto JSON body", async () => {
  const source = await readFile(new URL("../packages/core/src/grpc-web-client.ts", import.meta.url), "utf8");

  assert.match(source, /normalizeGrpcJsonBody\(parsedBody, serviceDef\.methods\[resolvedMethodName\]\.I\)/);
  assert.match(source, /await clientMethod\(requestData\)/);
  assert.doesNotMatch(source, /await clientMethod\(parsedBody\)/);
});

test("gRPC-Web preserves the actual HTTP status on transport errors", async () => {
  const source = await readFile(new URL("../packages/core/src/grpc-web-client.ts", import.meta.url), "utf8");
  assert.match(source, /statusCode: inspection\?\.status \?\? 200/);
});

test("gRPC-Web ConnectError responses are marked as errors", async () => {
  const source = await readFile(new URL("../packages/core/src/grpc-web-client.ts", import.meta.url), "utf8");

  assert.match(source, /error: ce\.rawMessage/);
  assert.match(source, /safeResponseMetadata\(ce\.metadata\)/);
});

test("gRPC-Web transport inspection records safe response framing diagnostics", async () => {
  const { inspectGrpcWebResponse } = await loadGrpcWebDebugModule();
  const response = new Response(new Uint8Array([0, 0, 0, 0, 2, 0x7b, 0x7d]), {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/grpc-web+proto",
      "content-encoding": "identity",
      "grpc-status": "0",
      "grpc-message": "",
      "x-penguin-http-status": "200",
      "x-penguin-response-bytes": "7",
      "x-penguin-response-prefix": "00000000027b7d",
    },
  });

  const result = await inspectGrpcWebResponse(response);

  assert.deepEqual(result, {
    status: 200,
    statusText: "OK",
    url: "",
    contentType: "application/grpc-web+proto",
    contentEncoding: "identity",
    grpcStatus: "0",
    grpcMessage: "",
    contentLength: null,
    bytes: 7,
    prefixHex: "00000000027b7d",
  });
});

test("Tauri gRPC-Web proxy preserves raw response inspection headers", async () => {
  const source = await readFile(new URL("../src/lib/proxy-fetch.ts", import.meta.url), "utf8");

  assert.match(source, /x-penguin-http-status/);
  assert.match(source, /x-penguin-response-bytes/);
  assert.match(source, /x-penguin-response-prefix/);
  assert.match(source, /x-penguin-grpc-status/);
});

test("Rust proxy preserves framing diagnostics when response body reading fails", async () => {
  const source = await readFile(new URL("../src-tauri/src/proxy.rs", import.meta.url), "utf8");

  assert.match(source, /x-penguin-http-version/);
  assert.match(source, /x-penguin-content-length/);
  assert.match(source, /x-penguin-transfer-encoding/);
  assert.match(source, /body read failed/);
});

test("desktop gRPC-Web wrapper carries proxy diagnostics through Connect errors", async () => {
  const source = await readFile(new URL("../src/lib/grpc-web-client.ts", import.meta.url), "utf8");

  assert.match(source, /transportHeaders/);
  assert.match(source, /headers:\s*\{\s*\.\.\.transportHeaders/);
});

test("gRPC-Web inspection accepts diagnostics already attached by the Tauri proxy", async () => {
  const { inspectGrpcWebResponse } = await loadGrpcWebDebugModule();
  const response = new Response(null, {
    status: 200,
    headers: {
      "x-penguin-http-status": "200",
      "x-penguin-content-type": "application/grpc-web+proto",
      "x-penguin-content-encoding": "identity",
      "x-penguin-grpc-status": "2",
      "x-penguin-grpc-message": "error decoding response body",
      "x-penguin-response-bytes": "19",
      "x-penguin-response-prefix": "7b22636f6465223a327d",
    },
  });

  const result = await inspectGrpcWebResponse(response);

  assert.equal(result.bytes, 19);
  assert.equal(result.prefixHex, "7b22636f6465223a327d");
  assert.equal(result.grpcStatus, "2");
  assert.equal(result.grpcMessage, "error decoding response body");
});
