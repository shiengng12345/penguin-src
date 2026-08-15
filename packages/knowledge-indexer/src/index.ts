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
export { createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir, startNotesWatcher, noteSlug, type NoteType } from "./notes-fs.js";
export { listEvidenceNotes, setEvidenceStatus, evidenceDoctor, repairEvidence, type EvidenceFileSummary, type EvidenceLifecycle, type EvidenceDoctorReport } from "./notes-fs.js";
export { computeEvidenceHashes, mergeEvidenceDocument, renderEvidenceMarkdown, upsertEvidenceNote, type EvidenceTarget, type TargetEvidencePacket, type EvidenceCaptureResult, type EvidenceDocument } from "./evidence.js";
export { resolveNoteLinks, listDanglingNoteLinks, type DanglingNoteLink } from "./fusion.js";
export { findUnlinkedMentions, acceptUnlinkedMention, type UnlinkedMention } from "./unlinked-mentions.js";
export { readGitContext, type GitContext } from "./git.js";
export { catalogGitRefs, resolveDefaultBranch, resolveRevisionTopology, GitObjectReader, type GitRefEntry, type GitRefCatalogue, type DefaultBranchResolution, type ResolvedRevisionTopology, type GitTreeFile } from "./git-topology.js";
export { resolutionContextFingerprint, dependentInvalidationClosure, type ResolutionContextInput } from "./resolution-context.js";
export { RevisionIndexCoordinator, extractFileFact, indexRevision, type IndexRevisionInput, type IndexRevisionReport } from "./revision-indexer.js";
export { ensureBaseSnapshot, type BaseSnapshotMaterializer } from "./base-snapshot.js";
export { walkRepoFiles, isLikelyMinified, type WalkedFile } from "./walk.js";
export { discoverRepoFiles, discoverRepoCoverage } from "./walk.js";
export type { DiscoveredFile, CoverageSummary, DiscoveryReport, CoverageWarning } from "./coverage.js";
export { DEFAULT_COVERAGE_POLICY, classifyCoveragePath, type CoveragePolicy } from "./coverage-policy.js";
export { classifyTextBuffer, decodeTextBuffer, type TextClassification } from "./text-classifier.js";
export { hashFileStream, decodeTextFileStream } from "./encoding.js";
export { summarizeCoverage } from "./coverage.js";
export { extractMarkdownProperties, validateMarkdownProperties, type MarkdownProperty, type MarkdownPropertyValidation } from "./markdown-properties.js";
export { extractMarkdownLinks, type MarkdownLink } from "./markdown-links.js";
export { parseCanvas, serializeCanvas, canvasToSearchableMarkdown, exportGraphSelectionToCanvas, type CanvasDocument, type CanvasNode, type CanvasEdge, type CanvasGraphSelection } from "./canvas.js";
export { ingestSourceFile, type SourceIngestResult } from "./source-ingest.js";
export { indexGitObjects, type GitGraphResult } from "./gitgraph.js";
export {
  indexRepo,
  reconcileOnStartup,
  IndexTaskLock,
  resolveIndexMode,
  KNOWLEDGE_PARSER_VERSION,
  KNOWLEDGE_RESOLVER_VERSION,
  type IndexReport,
  type IndexProgressEvent,
  type IndexStageId,
} from "./pipeline.js";
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
export { extractFieldAccesses, type FieldAccess, type FieldAccessKind } from "./field-access.js";
export { extractChannelBindings, type ExtractedChannelBinding, type ChannelProtocol, type ChannelBindingStatus } from "./channels.js";
export { deploymentBlastRadius, extractIacFacts, type DeploymentBlastRadiusResult, type IacFact, type IacKind } from "./iac.js";
export { anonymousCallbackIdentity } from "./identity.js";
