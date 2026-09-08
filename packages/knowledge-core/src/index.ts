export const KNOWLEDGE_CORE_VERSION = "0.0.1";
export { canonicalJson, sha256Canonical, sha256Hex } from "./canonical.js";
export {
  CORPUS_EXPORT_VERSION,
  CORPUS_EXPORT_VOLATILE_FIELDS,
  exportCanonicalCorpus,
  type CanonicalCorpusExport,
} from "./corpus-export.js";
export {
  Ledger,
  eventChecksum,
  readLedgerFile,
  type LedgerEvent,
  type LedgerEventInput,
  type LedgerMethod,
  type LedgerOrigin,
  type LedgerReadResult,
  type LedgerTarget,
} from "./ledger.js";
export {
  SCHEMA_VERSION,
  INDEX_FORMAT_VERSION,
  SCHEMA_MIGRATIONS,
  SCHEMA_TABLES,
  schemaMigrationBackupPath,
  assertSchemaVersionSupported,
  ensureDatabaseInstanceId,
  openDatabase,
  type OpenDatabaseOptions,
  type SchemaMaintenanceEvent,
} from "./schema.js";
export { SourceStore, type EffectiveSource, type PutBlobInput, type PutSourceFactInput, type SourceCoverageInput } from "./source-store.js";
export { buildLineIndex, locateOffset, type LineIndex, type LineIndexEntry } from "./line-index.js";
export {
  packageDependencies,
  dependencyPath,
  type DependencyDirection,
  type PackageDependencyNode,
  type PackageDependencyCandidate,
  type PackageDependencyQueryResult,
  type DependencyPathResult,
} from "./package-query.js";
export { materialize, LedgerGapError } from "./materializer.js";
export {
  KnowledgeStore,
  type NodeRow,
  type ParsedEdge,
  type SearchHit,
  type MasterBranchSelection,
} from "./store.js";
export {
  resolveRevisionContext,
  requireRevisionContext,
  RevisionResolutionError,
  type RevisionSelector,
  type RevisionContext,
  type RevisionResolution,
} from "./revision.js";
export {
  WORKING_TREE_OVERLAY_PREFIX,
  workingTreeOverlaySnapshotKey,
  isWorkingTreeOverlaySnapshotKey,
  isWorkingTreeRevision,
  workingTreeRevisionKind,
  type WorkingTreeOverlayStatus,
  type WorkingTreeOverlayResult,
} from "./working-tree-overlay.js";
export { legacyRevisionScope, type RevisionReadScope } from "./revision-scope.js";
export {
  resolveQueryScope,
  resolveRepoForPath,
  readGitStateDefault,
  cachedGitStateReader,
  ScopeResolutionError,
  type GitState,
  type GitStateReader,
  type ResolveQueryScopeInput,
  type ResolvedQueryScope,
  type ScopeResolutionErrorCode,
} from "./query-scope.js";
export {
  buildStatusPanel,
  type StatusPanel,
  type RepoStatusPanel,
} from "./status-panel.js";
export {
  GitTopologyStore,
  type GitCommitRecord,
  type CreateSnapshotInput,
  type RevisionSnapshot,
  type DeploymentRevision,
  type RevisionReference,
} from "./git-topology-store.js";
export {
  FileFactStore,
  fileFactId,
  type FileFactSymbol,
  type ParsedFileFact,
  type ParsedImportFact,
  type ParsedReferenceFact,
  type ParsedEndpointFact,
  type ParsedLogSiteFact,
  type SnapshotOverlayEntry,
  type SnapshotRenameEvent,
} from "./file-fact-store.js";
export { SourceSnapshotStore, type SourceSnapshotOverlayEntry } from "./source-cow.js";
export { backfillSourceCorpus, type SourceBackfillOptions, type BackfillReport } from "./source-backfill.js";
export { searchSource, searchSourceTerms, type ResolvedRevisionScope, type SourceSearchOccurrence, type SourceTermSearchOccurrence } from "./source-search.js";
export { getSourceHit, locateSourceRange, sourceSnippet, type SourceHitRequest, type SourceLocation } from "./source-snippet.js";
export { searchPath, type PathSearchHit } from "./path-search.js";
export { searchRegex, type RegexSearchOptions, type RegexSearchResult } from "./regex-search.js";
export { searchKnowledge, type SearchContext } from "./search-engine.js";
export { searchKnowledgeAsync } from "./search-engine.js";
export { traceDataFlow, traceDataFlowPath, traceVerifiedInterproceduralFlow, type DataFlowRequest, type DataFlowResult, type DataFlowStep, type DataFlowPath, type DataFlowPathRequest, type GraphEndpoint, type VerifiedCallEdge, type InterproceduralDataFlowRequest } from "./data-flow.js";
export { ExternalSourceStore, fingerprintMarkdownDirectory, syncMarkdownDirectory, syncRemoteSource, syncPostgresSchema, validateExternalLocation, type ExternalKnowledgeSource, type ExternalKnowledgeSourceType, type MarkdownDirectorySyncResult, type RemoteSyncResult, type PostgresSchemaClient, type PostgresSchemaSyncResult } from "./external-source.js";
export { planSearch, parseKnowledgeQuery, SEARCH_PLANNER_VERSION, type SearchPlan, type ParsedKnowledgeQuery } from "./search-planner.js";
export { rankSearchHits, rankTupleForHit, SEARCH_RANKER_VERSION, LANE_WEIGHTS, semanticLaneScore, type RankTuple } from "./search-ranking.js";
export { HmacSearchCursorCodec, HmacOperationCursorCodec, resolveLocalCursorSecret, type OperationCursorPayload } from "./search-cursor.js";
export { listCoverageDebt, type CoverageDebtKind, type CoverageDebtItem, type CoverageDebtRequest, type CoverageDebtResult } from "./coverage-query.js";
export { createWhyCard, transitionWhyCard, WhyCardStore, type WhyCard } from "./why-card.js";
export { MemoryStore, type MemoryItem, type MemoryClass } from "./memory.js";
export { ValidatedFindingStore, type ValidatedFinding, type FindingStatus } from "./validated-findings.js";
export { OntologyStore, type OntologyTerm, type OntologyAliasCandidate, type OntologyAliasResolution } from "./ontology.js";
export { buildOnboarding, buildOnboardingDocument, type OnboardingDocument } from "./onboarding.js";
export { buildDomainClaims, buildDomainFlow, explainDomain, DomainScopeError, type DomainClaimCandidate, type DomainFlowStep, type DomainPersona, type DomainExplainResult, type DomainQueryEnvelope, type DomainQueryOptions } from "./domain-model.js";
export { EvidenceStore, type EvidenceRecord, type EvidenceStatus } from "./evidence-state.js";
export { AuditStore } from "./audit.js";
export { sanitizeUntrustedText, isPromptLikeContent, type SafeText } from "./content-safety.js";
export { parseWorkspaceRoots, canonicalExistingPath, canonicalPathForCheck, isPathWithinWorkspace, assertWorkspacePath } from "./workspace-scope.js";
export { exportKnowledgeArtifact, previewKnowledgeArtifact, type ArtifactExportOptions, type ArtifactPreview } from "./artifact-export.js";
export { importKnowledgeArtifact, inspectKnowledgeArtifact, restoreKnowledgeArtifact, type ArtifactImportResult, type ArtifactConflictReport } from "./artifact-import.js";
export type { KnowledgeArtifactManifest } from "./artifact-manifest.js";
export { buildLogicalDelta, applyLogicalDelta, type LogicalDelta, type LogicalDeltaOperation } from "./artifact-delta.js";
export {
  captureProtectedAssets,
  captureCorpusBaseline,
  createConsistentDatabaseBackup,
  databaseInstanceId,
  readProtectedAssetBundle,
  restoreProtectedAssets,
  writeCorpusBaseline,
  writeProtectedAssetBundle,
  PROTECTED_ASSET_TABLES,
  MIXED_ASSET_TABLES,
  REBUILDABLE_ASSET_TABLES,
  type AssetRestoreReceipt,
  type CorpusBaseline,
  type CorpusBaselineOptions,
  type CorpusBaselineRepository,
  type CorpusBaselineRepositoryBranch,
  type DatabaseBackupReceipt,
  type KnowledgeDatabaseHandle,
  type ProtectedAssetBundle,
  type ProtectedAssetRestoreOptions,
  type ProtectedAssetRow,
  type ProtectedAssetTable,
  type ProtectedAssetValue,
} from "./asset-export.js";
export {
  createFullResetPlan,
  executeFullReset,
  finalizeFullReset,
  protectedNodeIdsFromAssets,
  recoverFullReset,
  reissueFullResetPlan,
  rollbackFullReset,
  type FullResetExecutionOptions,
  type FullResetFinalizeOptions,
  type FullResetCrashRecoveryReceipt,
  type FullResetPlanOptions,
  type FullResetPlanningResult,
  type FullResetReissueOptions,
  type FullResetReissueResult,
  type FullResetReceipt,
  type FullResetRollbackReceipt,
} from "./index-reset.js";
export {
  appendResetManifestPhase,
  consumeResetPlan,
  createFullResetConfirmationToken,
  fullResetManifestPath,
  fullResetPlanDigest,
  readResetManifest,
  resetManifestFileIdentity,
  writeResetManifest,
  type FullResetPhase,
  type FullResetPlan,
  type FullResetRepositoryPlan,
  type ResetManifest,
  type ResetManifestPhaseRecord,
} from "./reset-manifest.js";
export { graphQuery, type GraphQueryRequest, type GraphQueryResult } from "./graph-query.js";
export {
  CORPUS_RECONCILIATION_VERSION,
  readPersistedCorpusTruth,
  reconcileCorpus,
  type CorpusCountVector,
  type CorpusEndpointReconciliation,
  type CorpusLayer,
  type CorpusLayerReconciliation,
  type CorpusParserTruth,
  type CorpusPersistedTruth,
  type CorpusReconciliationResult,
  type CorpusScope,
  type CorpusSourceTruth,
  type CorpusTransportTruth,
} from "./corpus-reconciliation.js";
export { resolveTarget, TargetResolutionError, type ResolvedTarget, type ResolvedTargetNodeType, type ResolveTargetOptions, type TargetResolutionErrorCode } from "./target-resolution.js";
export { classifyEdgeTrust, type EdgeProofKind, type EdgeProofInput, type EdgeTrust } from "./edge-proof.js";
export { graphEdgeEvidence, unresolvedGraphEdgeEvidence, isExecutionEdge, isReferenceEdge, EXECUTION_EDGE_TYPES, REFERENCE_EDGE_TYPES, type RawGraphEdgeEvidence } from "./graph-evidence.js";
export { compileKnowledgeDsl, type CompiledKnowledgeDsl, type KnowledgeDslExpression, type KnowledgeDslPredicate } from "./knowledge-dsl.js";
export { filterHitsByPropertyPredicates, filterHitsByMarkdownPredicates } from "./property-search.js";
export { UnavailableEmbeddingProvider, inspectLocalModelDirectory, inspectLocalEmbeddingDirectory, createRemoteEmbeddingProvider, type EmbeddingProvider, type LocalModelManifest, type LocalModelDescriptor, type LocalEmbeddingManifest, type LocalEmbeddingDescriptor, type RemoteEmbeddingProviderOptions } from "./embedding-provider.js";
export { searchPersistedVectors, fuseHybridHits, type HybridSearchConfig, type PersistedVectorSearchInput, type PersistedVectorSearchResult, type RetrievalProvenance } from "./hybrid-search.js";
export { recordSearchFeedback, listSearchFeedback, deleteSearchFeedback, exportSearchFeedback, type FeedbackVerdict } from "./search-feedback.js";
export { SavedQueryStore, writeSavedQueryMarkdown, type SavedQuery } from "./saved-query.js";
export { reflectSearchFeedback, listReflectionSuggestions, reviewReflectionSuggestion, type ReflectionSuggestion } from "./reflection.js";
export { ResolutionStore, type ResolvedEdgeFact, type ResolutionSetRecord } from "./resolution-store.js";
export { ResolutionProviderChain, type ResolutionProvider, type ResolutionProviderKind, type ResolutionRequest, type ResolutionResult, type ResolutionTarget } from "./resolution-provider.js";
export { applyRuntimeDispatchObservation, frameworkEdgeEvidence, resolveDispatch, resolveFrameworkDispatch, type DispatchImplementation, type DispatchRequest, type DispatchResolution, type DispatchTarget, type FrameworkDispatchAdapter, type FrameworkEdgeEvidence, type FrameworkEdgeType, type RuntimeDispatchObservation } from "./dispatch-resolution.js";
export { DEFAULT_REVISION_RETENTION, planRevisionCollection, applyRevisionCollection, type RevisionRetentionPolicy, type RevisionCollectionPlan, type RevisionCollectionApplyResult, type RevisionCollectionTrigger } from "./revision-retention.js";
export { buildStorageReport, runStorageMaintenance, maintenanceState, evaluateStorageHealth, readStorageFileSizes, recordStorageSample, analyzeStorageTables, type StorageReport, type SemanticStorageReport, type StorageFileSizes, type StorageHealth, type StorageHealthLevel, type StorageTablesSection, type StorageTableCategory, type StorageRepoRow, type GcRunRecord, type MaintenanceState, type MaintenanceResult, type BuildStorageReportOptions } from "./storage-report.js";
export { trigramLaneEnabled, setTrigramLane, pruneTrigramLane, trigramLaneStatus, TRIGRAM_LANE_META_KEY } from "./trigram-lane.js";
export { openRevisionView, type RevisionView, type RevisionFileRow, type RevisionSymbolRow, type RevisionEdgeFilter, type RevisionEdgeRow } from "./revision-view.js";
export { CodeVersionResolver, type CodeVersionRequest, type CodeVersionResolution, type CodeVersionResolverDeps } from "./code-version-resolver.js";
export { resolveBranchBase, type BranchBaseInput, type BranchBaseReason, type BranchBaseResolution } from "./branch-base.js";
export {
  searchLegacyRows,
  getNodeDetail,
  exploreGraph,
  compareBranches,
  indexStatus,
  compactIndexStatus,
  listSuggestions,
  listTags,
  listIndexedFiles,
  listFileSymbols,
  graphNeighborhood,
  repoGraph,
  serviceGraph,
  serviceContext,
  servicePath,
  buildContextPack,
  buildExplorePack,
  renderContextPackMarkdown,
  buildFlow,
  renderFlowMarkdown,
  resolveGrpcEndpoint,
  type GrpcResolution,
  resolveSymbolMatches,
  renderAmbiguousSymbols,
  type SymbolCandidate,
  type SymbolResolution,
  type FlowDiagnostic,
  type FlowDiagnosticReason,
  affectedByFiles,
  affectedByNode,
  architecture,
  communities,
  timeline,
  endpointSamples,
  resolveEndpointId,
  type ResponseSample,
  deadCode,
  buildEvidenceEnvelope,
  withEvidenceEnvelope,
  readUnresolvedReferenceCoverage,
  type EvidenceEnvelope,
  type EvidenceCompleteness,
  type EvidenceProofStatus,
  type UnresolvedReferenceCoverageRow,
  type AffectedResult,
  type ArchitectureOverview,
  type Community,
  type CommunityResult,
  type TimelineEntry,
  type TimelineResult,
  type DeadCodeResult,
  branchFreshness,
  liveBranchOf,
  type BranchFreshness,
  type FlowResult,
  type FlowStep,
  type ContextPack,
  type ExternalCallGroup,
  type ContextBrief,
  type ExplorePack,
  type GraphMode,
  type GraphResult,
  type QueryDiagnostics,
  type NodeDetail,
  type BranchDiff,
  type IndexStatus,
  type CompactIndexStatus,
  type CompactRepoStatus,
  type SearchResultRow,
  type LegacySearchFilters,
  type IndexedFileRow,
  type FileSymbolRow,
  type GraphView,
  type ServiceContextResult,
} from "./query.js";
export {
  runtimeIndexCompatibility,
  assertRuntimeIndexCompatible,
  RuntimeIndexCompatibilityError,
  type RuntimeIndexCompatibility,
} from "./runtime-compatibility.js";
export { legacySearch as search, type LegacySearchResponse } from "./legacy-search.js";
export {
  resolveMutationTargetRoot,
  MutationTargetResolutionError,
  type MutationTargetResolutionErrorCode,
  type MutationTargetRootRequest,
  type MutationTargetRoot,
} from "./target-resolution.js";
