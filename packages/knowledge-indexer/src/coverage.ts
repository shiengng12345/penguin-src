import type { CoverageReasonCode, CoverageStatus } from "@penguin/knowledge-contracts";

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  gitState: "tracked" | "untracked" | "ignored";
  byteSize: number;
  classification: "source" | "config" | "documentation" | "generated" | "vendor" | "secret" | "binary" | "unknown";
  coverageStatus: CoverageStatus;
  reasonCode: CoverageReasonCode;
  reason: string;
  encoding?: "utf8" | "utf16le" | "utf16be";
  lineCount?: number;
  content?: string;
  isSymlink?: boolean;
}

export interface CoverageSummary {
  discovered: number;
  admitted: number;
  excluded: number;
  failed: number;
  stale: number;
  byReason: Record<string, number>;
}

export interface CoverageWarning {
  code: "IGNORED_METADATA_TRUNCATED";
  message: string;
}

export interface DiscoveryReport {
  files: DiscoveredFile[];
  warnings: CoverageWarning[];
}

export function summarizeCoverage(files: readonly DiscoveredFile[]): CoverageSummary {
  const summary: CoverageSummary = { discovered: files.length, admitted: 0, excluded: 0, failed: 0, stale: 0, byReason: {} };
  for (const file of files) {
    summary[file.coverageStatus] += 1;
    summary.byReason[file.reasonCode] = (summary.byReason[file.reasonCode] ?? 0) + 1;
  }
  return summary;
}
