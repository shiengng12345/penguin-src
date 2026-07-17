import type { CoverageReasonCode, CoverageStatus } from "@penguin/knowledge-contracts";
import { classifyCoveragePath, type CoveragePolicy } from "./coverage-policy.js";
import { decodeTextBuffer, hasNulByte, type SupportedTextEncoding } from "./encoding.js";

export interface TextClassification {
  status: CoverageStatus;
  reasonCode: CoverageReasonCode;
  reason: string;
  classification: ReturnType<typeof classifyCoveragePath>["classification"];
  encoding?: SupportedTextEncoding;
  text?: string;
  lineCount?: number;
}

export function classifyTextBuffer(
  bytes: Uint8Array,
  filePath: string,
  policy: CoveragePolicy,
): TextClassification {
  const pathResult = classifyCoveragePath(filePath, policy);
  if (pathResult.status === "excluded") return pathResult;
  const hasUtf16Bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (!hasUtf16Bom && hasNulByte(bytes, policy.sampleBytes)) {
    return { status: "excluded", reasonCode: "binary", reason: "NUL byte detected in content sample", classification: "binary" };
  }
  const decoded = decodeTextBuffer(bytes);
  if (!decoded.ok) {
    return { status: "excluded", reasonCode: "unsupported_encoding", reason: "file is not valid UTF-8/UTF-16 text", classification: pathResult.classification };
  }
  if (bytes.byteLength > policy.hardFileSizeBytes) {
    return { status: "excluded", reasonCode: "hard_size_limit", reason: "file exceeds hard coverage size limit", classification: pathResult.classification, encoding: decoded.encoding };
  }
  return {
    ...pathResult,
    encoding: decoded.encoding,
    text: decoded.text,
    lineCount: decoded.text.length === 0 ? 0 : decoded.text.split("\n").length,
  };
}

export { decodeTextBuffer } from "./encoding.js";
