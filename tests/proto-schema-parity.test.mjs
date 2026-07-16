import assert from "node:assert/strict";
import { test } from "node:test";
import { methodSchemaCompleteness, parseProtoContent } from "../packages/core/dist/index.js";

const raw = `syntax = "proto3"; package demo;
message Value { string value = 1; }
enum Status { STATUS_UNSPECIFIED = 0; STATUS_SUCCESS = 1; }
message Req { optional string nickname = 1; int32 platform_id = 2; map<string, Value> labels = 3; oneof identity { string email = 4; string phone = 5; } }
message Res { Status status = 1; }
service Demo { rpc Go(Req) returns (Res); }`;

test("raw proto exposes presence, map, oneof, enum and completeness metadata", () => {
  const service = parseProtoContent([{ name: "demo.proto", content: raw }])[0];
  const method = service.methods[0];
  const field = (name) => method.requestFields.find((item) => item.name === name);
  assert.equal(field("nickname").presence, "optional");
  assert.equal(field("platform_id").presence, "implicit");
  assert.deepEqual(field("labels").map, { keyType: "string", valueType: "Value", valueFields: [{ name: "value", type: "string", repeated: false, optional: false, presence: "implicit", fieldNumber: 1, jsonName: "value", schemaSource: "raw_proto" }] });
  assert.equal(field("email").oneof, "identity");
  assert.deepEqual(method.responseFields[0].enumValues, ["STATUS_UNSPECIFIED", "STATUS_SUCCESS"]);
  assert.equal(methodSchemaCompleteness(method).complete, true);
});

test("incomplete generated declarations report schema gaps instead of inventing metadata", () => {
  const files = [
    { name: "demo_connect.d.ts", content: `import { MethodKind } from "@bufbuild/protobuf"; export declare const Demo: { readonly typeName: "demo.Demo"; readonly Go: { readonly name: "Go"; readonly I: typeof Req; readonly O: typeof Res; readonly kind: MethodKind.Unary; }; };` },
    { name: "demo_pb.d.ts", content: `export declare class Req extends Message { /** @generated from field: map<string, unknown> labels = 1; */ labels: any; } export declare class Res extends Message { /** @generated from field: Status status = 1; */ status: number; }` },
  ];
  const method = parseProtoContent(files)[0].methods[0];
  const report = methodSchemaCompleteness(method);
  assert.ok(report.gaps.some((gap) => gap.code === "response_schema_empty" || gap.code === "enum_values_missing"));
});
