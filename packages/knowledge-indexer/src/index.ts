export const KNOWLEDGE_INDEXER_VERSION = "0.0.1";
export { loadParser, loadLanguage } from "./parser.js";
export { langForExtension, LANGS, WASM_FILE, type Lang } from "./registry.js";
export {
  extractSymbols,
  type ExtractedFile,
  type ExtractedSymbol,
  type ExtractedRef,
  type ExtractedLogSite,
} from "./extract.js";
export { extractEndpoints, extractRoutes, type ExtractedEndpoint, type ExtractedRoute } from "./routes.js";
export { extractGrpcClientCalls, grpcEndpointKey, type GrpcClientCall } from "./grpc-client.js";
export { parseProtoEndpoints, collectProtoEndpoints, type ProtoEndpoint } from "./proto-parser.js";
export { resolveRefs, type SymbolIndex, type ResolvedEdges } from "./resolve.js";
export { detectRenames, type RenameAliasEvent } from "./rename.js";
export { parseNote, indexNote, extractEntities, type ParsedNote } from "./notes.js";
export { createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir, noteSlug, type NoteType } from "./notes-fs.js";
export { listEvidenceNotes, setEvidenceStatus, evidenceDoctor, repairEvidence, type EvidenceFileSummary, type EvidenceLifecycle, type EvidenceDoctorReport } from "./notes-fs.js";
export { computeEvidenceHashes, mergeEvidenceDocument, renderEvidenceMarkdown, upsertEvidenceNote, type EvidenceTarget, type TargetEvidencePacket, type EvidenceCaptureResult, type EvidenceDocument } from "./evidence.js";
export { resolveNoteLinks } from "./fusion.js";
export { readGitContext, type GitContext } from "./git.js";
export { catalogGitRefs, resolveDefaultBranch, resolveRevisionTopology, GitObjectReader, type GitRefEntry, type GitRefCatalogue, type DefaultBranchResolution, type ResolvedRevisionTopology, type GitTreeFile } from "./git-topology.js";
export { resolutionContextFingerprint, dependentInvalidationClosure, type ResolutionContextInput } from "./resolution-context.js";
export { RevisionIndexCoordinator, extractFileFact, indexRevision, type IndexRevisionInput, type IndexRevisionReport } from "./revision-indexer.js";
export { ensureBaseSnapshot, type BaseSnapshotMaterializer } from "./base-snapshot.js";
export { walkRepoFiles, isLikelyMinified, type WalkedFile } from "./walk.js";
export { indexGitObjects, type GitGraphResult } from "./gitgraph.js";
export { indexRepo, reconcileOnStartup, IndexTaskLock, type IndexReport, type IndexProgressEvent, type IndexStageId } from "./pipeline.js";
export { startWatcher, type WatcherHandle, type WatcherStatus } from "./watcher.js";
export { detectPackages, flyoverPackageNames, buildPackageRegistry, type PackageInfo, type PackageRegistry } from "./package-detect.js";
export {
  readPackageDependencies,
  type DependencyScope,
  type DependencySource,
  type DependencySpec,
  type PackageDependencyEdge,
  type PackageDependencyReport,
} from "./package-dependencies.js";
export { extractIdentifiers, extractIdentifiersFromSource, type IdentifierEntry } from "./identifiers.js";
