export type CoverageStatus = "admitted" | "excluded" | "failed" | "stale";

export type CoverageReasonCode =
  | "text_searchable"
  | "binary"
  | "secret_policy"
  | "ignored_by_git"
  | "outside_workspace"
  | "generated_policy"
  | "vendor_policy"
  | "hard_size_limit"
  | "unsupported_encoding"
  | "read_error"
  | "hash_error"
  | "submodule";

export interface CoverageRecord {
  repoId: string;
  snapshotId: string;
  filePath: string;
  status: CoverageStatus;
  reasonCode: CoverageReasonCode;
  reason: string;
  contentHash?: string;
  sourceBlobId?: number;
  byteSize: number;
  lineCount?: number;
  encoding?: "utf8" | "utf16le" | "utf16be";
  classification:
    | "source"
    | "config"
    | "documentation"
    | "generated"
    | "vendor"
    | "secret"
    | "binary"
    | "unknown";
  parser: {
    status: "parsed" | "unsupported" | "failed" | "not_applicable";
    language?: string;
    version?: string;
    error?: string;
  };
  indexedAt: string;
}
