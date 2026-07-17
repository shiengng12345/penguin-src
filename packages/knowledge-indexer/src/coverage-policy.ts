import { posix } from "node:path";
import type { CoverageReasonCode, CoverageStatus } from "@penguin/knowledge-contracts";

export interface CoveragePolicy {
  includeUntracked: boolean;
  includeIgnoredMetadata: boolean;
  exactSearchGenerated: boolean;
  exactSearchVendor: boolean;
  ignoredMetadataMaxEntries: number;
  secretPaths: string[];
  hardFileSizeBytes: number;
  sampleBytes: number;
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  includeUntracked: true,
  includeIgnoredMetadata: true,
  exactSearchGenerated: true,
  exactSearchVendor: true,
  ignoredMetadataMaxEntries: 10_000,
  secretPaths: [".env", ".env.*", "**/*.pem", "**/*.key", "**/credentials.json"],
  hardFileSizeBytes: 4_294_967_295,
  sampleBytes: 65_536,
};

export interface PathCoverageClassification {
  status: CoverageStatus;
  reasonCode: CoverageReasonCode;
  reason: string;
  classification: "source" | "config" | "documentation" | "generated" | "vendor" | "secret" | "binary" | "unknown";
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isSecretPath(filePath: string, secretPaths: readonly string[]): boolean {
  const normalized = normalizePath(filePath);
  const base = posix.basename(normalized);
  return secretPaths.some((pattern) => {
    if (pattern === ".env" || pattern === ".env.*") return base === ".env" || base.startsWith(".env.");
    if (pattern === "**/*.pem") return normalized.endsWith(".pem");
    if (pattern === "**/*.key") return normalized.endsWith(".key");
    if (pattern === "**/credentials.json") return base === "credentials.json";
    return normalized === pattern;
  });
}

function isGeneratedPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(^|\/)(?:dist|build|generated|coverage|\.next)\//i.test(normalized) || /\.min\.(?:js|mjs|cjs|css)$/i.test(normalized) || /[.-]bundle\.js$/i.test(normalized);
}

function isVendorPath(filePath: string): boolean {
  return /(^|\/)(?:public|static|assets|www|TestPage)\/(?:[^/]+\/)*(?:lib|libs|vendor|common)\//i.test(normalizePath(filePath));
}

export function classifyCoveragePath(
  filePath: string,
  policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY,
): PathCoverageClassification {
  const normalized = normalizePath(filePath);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return { status: "excluded", reasonCode: "outside_workspace", reason: "path escapes repository workspace", classification: "unknown" };
  }
  if (isSecretPath(normalized, policy.secretPaths)) {
    return { status: "excluded", reasonCode: "secret_policy", reason: "secret path excluded by policy", classification: "secret" };
  }
  if (isGeneratedPath(normalized)) {
    if (!policy.exactSearchGenerated) {
      return { status: "excluded", reasonCode: "generated_policy", reason: "generated path excluded by local policy", classification: "generated" };
    }
    return { status: "admitted", reasonCode: "text_searchable", reason: "generated text admitted to exact/path corpus", classification: "generated" };
  }
  if (isVendorPath(normalized)) {
    if (!policy.exactSearchVendor) {
      return { status: "excluded", reasonCode: "vendor_policy", reason: "vendor path excluded by local policy", classification: "vendor" };
    }
    return { status: "admitted", reasonCode: "text_searchable", reason: "vendor text admitted to exact/path corpus", classification: "vendor" };
  }
  const extension = posix.extname(normalized).toLowerCase();
  const classification = extension === ".md" || extension === ".mdx" || extension === ".txt" || extension === ".rst"
    ? "documentation"
    : [".yml", ".yaml", ".json", ".toml", ".sql", ".proto", ".env"].includes(extension)
      ? "config"
      : "source";
  return { status: "admitted", reasonCode: "text_searchable", reason: "text file admitted to exact/path corpus", classification };
}
