// Protocol-agnostic types shared by Penguin desktop app and future MCP/CLI
// runtimes. UI-domain types (RequestTab, AppTheme, etc.) stay in the desktop
// app's store.ts — only data shapes that describe RPC traffic live here.

export interface ProtoService {
  name: string;
  fullName: string;
  methods: ProtoMethod[];
}

export interface ProtoMethod {
  name: string;
  fullName: string;
  requestType: string;
  responseType: string;
  requestFields: FieldInfo[];
  responseFields: FieldInfo[];
  schemaSource?: "raw_proto" | "generated_dts" | "sdk_dts";
  schemaGaps?: SchemaGap[];
}

export interface FieldInfo {
  name: string;
  type: string;
  repeated: boolean;
  optional: boolean;
  presence?: "required" | "optional" | "implicit";
  fields?: FieldInfo[];
  enumValues?: string[];
  enumNumbers?: Record<string, number>;
  map?: { keyType: string; valueType: string; valueFields?: FieldInfo[]; valueEnumValues?: string[] };
  oneof?: string;
  defaultValue?: string | number | boolean;
  fieldNumber?: number;
  jsonName?: string;
  schemaSource?: "raw_proto" | "generated_dts" | "sdk_dts";
  schemaGaps?: string[];
}

export interface SchemaGap {
  code: "request_schema_empty" | "response_schema_empty" | "enum_values_missing" | "map_value_type_missing" | "oneof_metadata_missing" | "presence_unknown" | "dependency_artifact_unavailable";
  fieldPath: string;
  schemaSource: "raw_proto" | "generated_dts" | "sdk_dts";
}

export interface MetadataEntry {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ResponseState {
  status: string;
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  duration: number;
  error?: string;
}

export interface ConnectMessageType {
  typeName: string;
  fields: unknown;
  fromJson?: (value: unknown, options?: { ignoreUnknownFields?: boolean }) => unknown;
}

// Connect-RPC generated service descriptor shape. `fields` is the runtime
// protobuf-es descriptor — opaque, typed loosely on purpose.
export interface ConnectMethodDef {
  name?: string;
  kind?: number;
  I?: ConnectMessageType;
  O?: { typeName: string };
}

export interface ConnectServiceDef {
  typeName: string;
  methods: Record<string, ConnectMethodDef>;
}
