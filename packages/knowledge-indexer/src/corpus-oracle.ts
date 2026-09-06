import { readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { discoverRepoCoverage } from "./walk.js";
import { extractEndpoints } from "./routes.js";
import { langForExtension } from "./registry.js";
import { parseProtoEndpoints } from "./proto-parser.js";
import { readGitContext, type GitContext } from "./git.js";
import { withParsedTree } from "./parser.js";

export interface IndependentEndpointRecord {
  key: string;
  filePath: string;
  startLine: number;
  source: "proto" | "tree-sitter";
}

export interface IndependentCorpusOracle {
  rootPath: string;
  git: Pick<GitContext, "branch" | "commit" | "worktreeState" | "worktreeFingerprint" | "dirtyFiles">;
  source: {
    discoveredFiles: number;
    admittedFiles: number;
    excludedFiles: number;
    failedFiles: number;
    staleFiles: number;
    parserEligibleFiles: number;
    endpointKeys: string[];
    endpointOccurrences: number;
  };
  endpointRecords: IndependentEndpointRecord[];
  parserErrors: Array<{ filePath: string; error: string }>;
  discoveryWarnings: Array<{ code: string; message: string }>;
}

function protoPackage(source: string): string | null {
  return source.match(/\bpackage\s+([A-Za-z_][\w.]*)\s*;/)?.[1] ?? null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}

/**
 * Independently walk and parse the current checkout. This intentionally does
 * not read parser counts, CLI output, or endpoint rows from SQLite; it is the
 * source-side oracle used to detect publication loss and coverage drift.
 */
export async function collectIndependentCorpusOracle(rootPath: string): Promise<IndependentCorpusOracle> {
  const canonicalRoot = realpathSync.native(rootPath);
  const git = readGitContext(canonicalRoot);
  const discovery = discoverRepoCoverage(canonicalRoot);
  const admittedFiles = discovery.files.filter((file) => file.coverageStatus === "admitted" && !file.isSymlink);
  const records: IndependentEndpointRecord[] = [];
  const parserErrors: Array<{ filePath: string; error: string }> = [];
  const sources: Array<{ file: (typeof admittedFiles)[number]; extension: string; source: string }> = [];
  const canonicalProtoKeys = new Map<string, Set<string>>();
  for (const file of admittedFiles) {
    const extension = extname(file.relativePath).toLowerCase();
    try {
      sources.push({ file, extension, source: readFileSync(file.absolutePath, "utf8") });
    } catch (error) {
      parserErrors.push({ filePath: file.relativePath, error: String((error as Error)?.message ?? error) });
    }
  }
  // Build the local proto identity map first. NestJS providers commonly use an
  // unqualified @GrpcMethod("Service", "Method") while the canonical endpoint
  // is package-qualified by a proto declaration in the same repository.
  for (const { file, extension, source } of sources) {
    if (extension === ".proto") {
      const packageName = protoPackage(source);
      for (const endpoint of parseProtoEndpoints(source, file.relativePath)) {
        const unqualified = `${endpoint.service}.${endpoint.method}`;
        const canonical = `gRPC ${packageName ? `${packageName}.` : ""}${unqualified}`;
        const candidates = canonicalProtoKeys.get(unqualified) ?? new Set<string>();
        candidates.add(canonical);
        canonicalProtoKeys.set(unqualified, candidates);
        records.push({
          key: canonical,
          filePath: file.relativePath,
          startLine: endpoint.startLine,
          source: "proto",
        });
      }
    }
  }
  for (const { file, extension, source } of sources) {
    if (extension === ".proto") continue;
    const lang = langForExtension(file.relativePath);
    if (!lang) continue;
    try {
      const endpoints = await withParsedTree(lang, source, extractEndpoints, []);
      for (const endpoint of endpoints) {
        let key = endpoint.key;
        if (endpoint.protocol === "grpc" && endpoint.grpcService && endpoint.grpcMethod && !endpoint.grpcPackageName) {
          const candidates = canonicalProtoKeys.get(`${endpoint.grpcService}.${endpoint.grpcMethod}`);
          if (candidates?.size === 1) key = [...candidates][0];
        }
        records.push({
          key,
          filePath: file.relativePath,
          startLine: endpoint.startLine,
          source: "tree-sitter",
        });
      }
    } catch (error) {
      parserErrors.push({ filePath: file.relativePath, error: String((error as Error)?.message ?? error) });
    }
  }
  return {
    rootPath: canonicalRoot,
    git: {
      branch: git.branch,
      commit: git.commit,
      worktreeState: git.worktreeState,
      worktreeFingerprint: git.worktreeFingerprint,
      dirtyFiles: git.dirtyFiles,
    },
    source: {
      discoveredFiles: discovery.files.length,
      admittedFiles: admittedFiles.length,
      excludedFiles: discovery.files.filter((file) => file.coverageStatus === "excluded").length,
      failedFiles: discovery.files.filter((file) => file.coverageStatus === "failed").length,
      staleFiles: discovery.files.filter((file) => file.coverageStatus === "stale").length,
      parserEligibleFiles: admittedFiles.filter((file) => langForExtension(file.relativePath) || extensionIsProto(file.relativePath)).length,
      endpointKeys: sortedUnique(records.map((record) => record.key)),
      endpointOccurrences: records.length,
    },
    endpointRecords: records,
    parserErrors,
    discoveryWarnings: discovery.warnings,
  };
}

function extensionIsProto(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".proto";
}
