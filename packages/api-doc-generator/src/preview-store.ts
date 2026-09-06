import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ApiDocPreview, ApiDocPreviewManifest, ApiDocPreviewPruneResult, ApiDocPreviewSaveResult, ApiDocPreviewDiff, ApiDocumentationIR, RenderedDocument } from "./types.js";
import { renderApiDocumentation } from "./markdown-renderer.js";
function safe(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function previewId(documentKey: string, revisionSetHash: string): string { return `preview:v1:${safe(documentKey)}:${safe(revisionSetHash)}`; }
function dirName(id: string): string { return id.replaceAll(":", "_"); }
function writeAtomic(path: string, value: string): void { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, value); renameSync(temp, path); }
type PreviewEvidenceState = "current" | "empty" | "stale" | "partial";
type HonestManifest = ApiDocPreviewManifest & { evidenceState: PreviewEvidenceState; proofStatus: "candidate" | "not_proven"; gaps: string[]; currentRevisionIds?: string[] };
export interface ApiDocPreviewReadOps { readText(path: string): string }
type UnreadablePreview = { candidate: string; reason: "missing_manifest" | "corrupt_manifest" | "read_error"; code: string | null; message: string };

function normalizePreviewIr(ir: ApiDocumentationIR): { ir: ApiDocumentationIR; evidenceState: PreviewEvidenceState; gaps: string[] } {
  const gaps = [
    ...(ir.revisions.length ? [] : ["preview_revisions_empty"]),
    ...(ir.endpoints.length ? [] : ["preview_endpoints_empty"]),
    ...(ir.evidence.length ? [] : ["preview_evidence_empty"]),
  ];
  if (gaps.length === 0) return { ir, evidenceState: ir.coverage.level === "partial" ? "partial" : "current", gaps: [] };
  const blocker = { gapId: "gap_document_evidence_empty", code: "document_evidence_empty", message: "The preview has insufficient revision, endpoint, or evidence provenance.", evidenceIds: [] };
  return {
    ir: {
      ...ir,
      gaps: ir.gaps.some((gap) => gap.code === blocker.code) ? ir.gaps : [...ir.gaps, blocker],
      coverage: { ...ir.coverage, level: "partial", runtimeEvidenceState: ir.coverage.runtimeEvidenceState === "available" ? "partial" : "unavailable", blockers: ir.coverage.blockers.some((gap) => gap.code === blocker.code) ? ir.coverage.blockers : [...ir.coverage.blockers, blocker] },
    },
    evidenceState: "empty",
    gaps: ["document_evidence_empty", ...gaps],
  };
}

function withCurrentRevision(manifest: HonestManifest, currentRevisionIds?: string[]): HonestManifest {
  if (!currentRevisionIds) return manifest;
  const expected = [...manifest.revisionIds].sort();
  const current = [...new Set(currentRevisionIds)].sort();
  const stale = expected.length !== current.length || expected.some((id, index) => id !== current[index]);
  return stale
    ? { ...manifest, coverage: "partial", evidenceState: "stale", proofStatus: "not_proven", gaps: [...new Set([...manifest.gaps, "preview_revision_stale"])], currentRevisionIds: current }
    : { ...manifest, currentRevisionIds: current };
}
export class ApiDocPreviewStore {
  constructor(private readonly rootDir: string, private readonly readOps: Partial<ApiDocPreviewReadOps> = {}) { mkdirSync(rootDir, { recursive: true }); }
  private location(id: string): string { return join(this.rootDir, dirName(id)); }
  private readText(path: string): string { return this.readOps.readText?.(path) ?? readFileSync(path, "utf8"); }
  private loadManifest(id: string): HonestManifest {
    const manifest = JSON.parse(this.readText(join(this.location(id), "manifest.json"))) as Partial<HonestManifest> & ApiDocPreviewManifest;
    return { ...manifest, evidenceState: manifest.evidenceState ?? (manifest.coverage === "partial" ? "partial" : "current"), proofStatus: manifest.proofStatus ?? (manifest.coverage === "partial" ? "not_proven" : "candidate"), gaps: manifest.gaps ?? [] };
  }
  save(input: { ir: ApiDocumentationIR; rendered: RenderedDocument; mode: ApiDocPreviewManifest["mode"]; protectedBy?: ApiDocPreviewManifest["protectedBy"]; now?: Date }): ApiDocPreviewSaveResult {
    const normalized = normalizePreviewIr(input.ir);
    const honestRendered = normalized.ir === input.ir ? input.rendered : renderApiDocumentation(normalized.ir);
    const id = previewId(normalized.ir.documentKey, honestRendered.revisionSetHash), dir = this.location(id), now = (input.now ?? new Date()).toISOString();
    const current = existsSync(join(dir, "manifest.json")) ? this.load(id) : null;
    if (current && current.rendered.markdown === honestRendered.markdown && JSON.stringify(current.ir) === JSON.stringify(normalized.ir)) return { status: "no_change", previewId: id, manifest: current.manifest };
    if (current && current.manifest.mode === "canonical" && current.rendered.revisionSetHash === honestRendered.revisionSetHash) return { status: "immutable_revision_conflict", previewId: id, reason: "canonical preview is immutable for this revision set" };
    const manifest: HonestManifest = { previewId: id, documentKey: normalized.ir.documentKey, revisionSetHash: honestRendered.revisionSetHash, mode: input.mode, title: normalized.ir.title, subjects: normalized.ir.endpoints.map((endpoint) => ({ service: endpoint.service, method: endpoint.method, route: endpoint.route })), searchTerms: [...new Set(normalized.ir.endpoints.flatMap((endpoint) => [endpoint.service, endpoint.method, endpoint.route]))], coverage: normalized.ir.coverage.level, sectionHashes: Object.fromEntries(honestRendered.sections.map((section) => [section.sectionKey, section.contentHash])), revisionIds: normalized.ir.revisions.map((revision) => revision.revisionId), sourceCommits: Object.fromEntries(normalized.ir.revisions.map((revision) => [revision.repo, revision.commitSha])), createdAt: current?.manifest.createdAt ?? now, updatedAt: now, protectedBy: [...new Set([...(current?.manifest.protectedBy ?? []), ...(input.protectedBy ?? [])])], evidenceState: normalized.evidenceState, proofStatus: normalized.evidenceState === "current" ? "candidate" : "not_proven", gaps: normalized.gaps };
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "ir.json"), JSON.stringify(normalized.ir, null, 2)); writeAtomic(join(dir, "document.md"), honestRendered.markdown); writeAtomic(join(dir, "document.xml"), honestRendered.larkXml); writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { status: current ? "updated" : "created", previewId: id, manifest };
  }
  load(id: string, options: { currentRevisionIds?: string[] } = {}): ApiDocPreview & { manifest: HonestManifest } {
    const preview = this.loadWithRendered(id) as ApiDocPreview & { manifest: HonestManifest };
    return { ...preview, manifest: withCurrentRevision(preview.manifest, options.currentRevisionIds) };
  }
  private loadWithRendered(id: string): ApiDocPreview { const dir = this.location(id); const manifest = this.loadManifest(id); const ir = JSON.parse(this.readText(join(dir, "ir.json"))) as ApiDocumentationIR; const markdown = this.readText(join(dir, "document.md")); const larkXml = this.readText(join(dir, "document.xml")); return { manifest, ir, rendered: { documentKey: manifest.documentKey, revisionSetHash: manifest.revisionSetHash, coverage: ir.coverage, sections: Object.entries(manifest.sectionHashes).map(([sectionKey, contentHash]) => ({ sectionKey, title: sectionKey, markdown: "", larkXml: "", contentHash })), markdown, larkXml } }; }
  private scan(filter: { documentKey?: string; mode?: ApiDocPreviewManifest["mode"]; query?: string; currentRevisionIds?: string[] } = {}): { items: HonestManifest[]; unreadable: UnreadablePreview[] } {
    const items: HonestManifest[] = [];
    const unreadable: UnreadablePreview[] = [];
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true }).filter((candidate) => candidate.isDirectory())) {
      try {
        const manifest = withCurrentRevision(this.loadManifest(entry.name.replaceAll("_", ":")), filter.currentRevisionIds);
        if ((!filter.documentKey || manifest.documentKey === filter.documentKey)
          && (!filter.mode || manifest.mode === filter.mode)
          && (!filter.query || `${manifest.title} ${manifest.searchTerms.join(" ")}`.toLowerCase().includes(filter.query.toLowerCase()))) items.push(manifest);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") || null : null;
        unreadable.push({
          candidate: entry.name,
          reason: code === "ENOENT" ? "missing_manifest" : error instanceof SyntaxError ? "corrupt_manifest" : "read_error",
          code,
          message: String((error as Error).message ?? error),
        });
      }
    }
    return { items, unreadable };
  }
  list(filter: { documentKey?: string; mode?: ApiDocPreviewManifest["mode"]; query?: string; currentRevisionIds?: string[] } = {}): HonestManifest[] { return this.scan(filter).items; }
  listEnvelope(filter: { documentKey?: string; mode?: ApiDocPreviewManifest["mode"]; query?: string; currentRevisionIds?: string[] } = {}) {
    const { items, unreadable } = this.scan(filter);
    const gaps = [...new Set(items.flatMap((item) => item.gaps))];
    const stale = items.some((item) => item.evidenceState === "stale");
    const incomplete = items.some((item) => item.proofStatus === "not_proven");
    const hasUnreadable = unreadable.length > 0;
    return {
      items,
      unreadableCount: unreadable.length,
      unreadable,
      scope: filter.documentKey ? { documentKey: filter.documentKey } : null,
      revision: filter.currentRevisionIds ? { revisionIds: [...new Set(filter.currentRevisionIds)].sort() } : null,
      freshness: { status: stale ? "stale" : filter.currentRevisionIds ? "fresh" : "unknown", indexedCommit: null, headCommit: null, dirtyFileCount: null },
      coverage: { status: items.length === 0 ? "unknown" : incomplete || hasUnreadable ? "partial" : "complete", discovered: hasUnreadable ? null : items.length || null, admitted: items.length || null, excluded: null, failed: hasUnreadable ? unreadable.length : null, stale: stale ? items.filter((item) => item.evidenceState === "stale").length : null, unresolvedReferences: null },
      completeness: items.length === 0 ? "unknown" : incomplete || stale || hasUnreadable ? "partial" : "lower_bound",
      proofStatus: items.length === 0 || incomplete || stale || hasUnreadable ? "not_proven" : "candidate",
      candidateCount: hasUnreadable ? null : items.length,
      returnedCount: items.length,
      remainingCount: hasUnreadable ? null : 0,
      totalIsExact: !hasUnreadable,
      truncated: false,
      nextCursor: null,
      gaps: [...new Set([...(items.length === 0 ? ["api_doc_previews_empty"] : []), ...(hasUnreadable ? ["api_doc_preview_unreadable"] : []), "unresolved_reference_coverage_unavailable", ...gaps])],
    } as const;
  }
  diff(leftPreviewId: string, rightPreviewId: string): ApiDocPreviewDiff { const left = this.loadWithRendered(leftPreviewId), right = this.loadWithRendered(rightPreviewId); const keys = new Set([...Object.keys(left.manifest.sectionHashes), ...Object.keys(right.manifest.sectionHashes)]); const addedSectionKeys = [...keys].filter((key) => !left.manifest.sectionHashes[key] && !!right.manifest.sectionHashes[key]); const removedSectionKeys = [...keys].filter((key) => !!left.manifest.sectionHashes[key] && !right.manifest.sectionHashes[key]); const changedSectionKeys = [...keys].filter((key) => left.manifest.sectionHashes[key] && right.manifest.sectionHashes[key] && left.manifest.sectionHashes[key] !== right.manifest.sectionHashes[key]); return { status: addedSectionKeys.length || removedSectionKeys.length || changedSectionKeys.length ? "changed" : "no_documented_change", addedSectionKeys, removedSectionKeys, changedSectionKeys, markdownDiff: left.rendered.markdown === right.rendered.markdown ? "" : `--- ${leftPreviewId}\n+++ ${rightPreviewId}\n${right.rendered.markdown}` }; }
  setProtection(id: string, reason: ApiDocPreviewManifest["protectedBy"][number], enabled: boolean): ApiDocPreviewManifest { const manifest = this.loadManifest(id); const protectedBy = enabled ? [...new Set([...manifest.protectedBy, reason])] : manifest.protectedBy.filter((item) => item !== reason); writeAtomic(join(this.location(id), "manifest.json"), JSON.stringify({ ...manifest, protectedBy, updatedAt: new Date().toISOString() }, null, 2)); return this.loadManifest(id); }
  prune(input: { keepRevisionIds: string[]; hotLimit: number; coldBefore: Date }): ApiDocPreviewPruneResult { const manifests = this.list(); const protectedPreviewIds = manifests.filter((manifest) => manifest.protectedBy.length).map((manifest) => manifest.previewId); const sorted = manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); const retained = sorted.slice(0, input.hotLimit).map((manifest) => manifest.previewId); const removedPreviewIds: string[] = []; for (const manifest of sorted.slice(input.hotLimit)) { const protectedItem = manifest.protectedBy.length || manifest.revisionIds.some((id) => input.keepRevisionIds.includes(id)); if (protectedItem || new Date(manifest.updatedAt) >= input.coldBefore) continue; rmSync(this.location(manifest.previewId), { recursive: true, force: true }); removedPreviewIds.push(manifest.previewId); } return { removedPreviewIds, retainedPreviewIds: this.list().map((manifest) => manifest.previewId), protectedPreviewIds }; }
}
