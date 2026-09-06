import { readFileSync } from "node:fs";
import { collectDocumentationFacts, buildApiDocumentation, renderApiDocumentation, validateDocumentationRequest, ApiDocPreviewStore, ApiDocBindingStore, syncManagedDocument, type DocumentationRequest, type DocumentationSourceAdapter, type LarkSectionClient } from "@penguin/api-doc-generator";

export interface ApiDocCommandDeps {
  previewRoot: string;
  sourceAdapter?: DocumentationSourceAdapter;
  readStdin?: () => Promise<string>;
  bindingPath?: string;
  larkClient?: LarkSectionClient;
  currentRevisionIds?: () => string[];
}

class ApiDocCommandError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

function staleDetails(preview: ReturnType<ApiDocPreviewStore["load"]>): Record<string, unknown> {
  return { previewId: preview.manifest.previewId, previewRevisionIds: preview.manifest.revisionIds, currentRevisionIds: preview.manifest.currentRevisionIds ?? [], gaps: preview.manifest.gaps };
}

function assertFreshPreview(preview: ReturnType<ApiDocPreviewStore["load"]>, allowStale: boolean): void {
  if (preview.manifest.evidenceState === "stale" && !allowStale) throw new ApiDocCommandError("API_DOC_PREVIEW_STALE", "preview revision is stale; pass --allow-stale only after reviewing the current revision mismatch", staleDetails(preview));
}

function renderPreviewOutput(preview: ReturnType<ApiDocPreviewStore["load"]>, format: string): string {
  if (preview.manifest.evidenceState !== "stale") return format === "xml" ? preview.rendered.larkXml : preview.rendered.markdown;
  const current = (preview.manifest.currentRevisionIds ?? []).join(", ") || "unknown";
  const revisions = preview.manifest.revisionIds.join(", ") || "unknown";
  const message = `API_DOC_PREVIEW_STALE | preview_revision_stale | preview revisions: ${revisions} | current revisions: ${current}`;
  return format === "xml"
    ? `<p><strong>${message}</strong></p>\n${preview.rendered.larkXml}`
    : `> [!WARNING]\n> ${message}\n\n${preview.rendered.markdown}`;
}

function requestInput(value: string | undefined, cwd: string, readStdin?: () => Promise<string>): Promise<string> {
  if (value === "-") return readStdin?.() ?? Promise.reject(new Error("stdin is not available"));
  if (!value) return Promise.reject(new Error("--request is required"));
  if (value.startsWith("/") || value.split("/").includes("..")) return Promise.reject(new Error("request path must be relative to cwd"));
  return Promise.resolve(readFileSync(`${cwd}/${value}`, "utf8"));
}

export async function runApiDocCommand(argv: string[], input: ApiDocCommandDeps & { cwd: string; out: (line: string) => void; err: (line: string) => void; json: boolean }): Promise<number> {
  const sub = argv[0];
  const value = (name: string) => { const i = argv.indexOf(`--${name}`); const inline = argv.find((item) => item.startsWith(`--${name}=`)); return inline ? inline.slice(name.length + 3) : i >= 0 ? argv[i + 1] : undefined; };
  const store = new ApiDocPreviewStore(input.previewRoot);
  const loadCurrent = (id: string) => store.load(id, { currentRevisionIds: input.currentRevisionIds?.() });
  const allowStale = argv.includes("--allow-stale");
  try {
    if (sub === "generate") {
      if (!input.sourceAdapter) throw new Error("API documentation source adapter is not configured");
      const raw = await requestInput(value("request"), input.cwd, input.readStdin);
      if (raw.length > 2 * 1024 * 1024) throw new Error("request exceeds 2 MiB limit");
      let request: DocumentationRequest;
      try { request = JSON.parse(raw) as DocumentationRequest; } catch { throw new Error("request must be valid JSON"); }
      const valid = validateDocumentationRequest(request); if (!valid.ok) { input.err(JSON.stringify(valid.errors)); return 2; }
      const collected = await collectDocumentationFacts(valid.request!, input.sourceAdapter);
      if (collected.status !== "collected") { input.out(JSON.stringify(collected)); return 1; }
      const generated = await buildApiDocumentation({ bundle: collected.bundle });
      if (generated.status !== "generated") { input.out(JSON.stringify(generated)); return 1; }
      const rendered = renderApiDocumentation(generated.ir);
      const saved = store.save({ ir: generated.ir, rendered, mode: request.mode === "sync" ? "preview" : request.mode });
      input.out(JSON.stringify(saved)); return saved.status === "immutable_revision_conflict" ? 1 : 0;
    }
    if (sub === "list") { input.out(JSON.stringify(store.listEnvelope({ documentKey: value("document-key"), query: value("query"), currentRevisionIds: input.currentRevisionIds?.() }))); return 0; }
    const id = argv[1];
    if (sub === "show" && id) { const preview = loadCurrent(id); const format = value("format") ?? "json"; input.out(format === "markdown" || format === "xml" ? renderPreviewOutput(preview, format) : JSON.stringify(preview)); return 0; }
    if (sub === "diff" && id) { const against = value("against"); if (!against) throw new Error("--against is required"); input.out(JSON.stringify(store.diff(id, against))); return 0; }
    if (sub === "export" && id) { const preview = loadCurrent(id); const format = value("format") ?? "markdown"; input.out(format === "json" ? JSON.stringify(preview.manifest.evidenceState === "stale" ? { ir: preview.ir, warning: { code: "API_DOC_PREVIEW_STALE", ...staleDetails(preview) } } : preview.ir) : renderPreviewOutput(preview, format)); return 0; }
    if (sub === "bind") {
      const documentKey = argv[1], nodeToken = value("node-token"), previewId = value("preview");
      if (!documentKey || !nodeToken || !previewId || !input.larkClient) throw new Error("bind requires document key, --node-token, --preview, and a configured Lark client");
      const preview = loadCurrent(previewId); assertFreshPreview(preview, allowStale); if (preview.manifest.documentKey !== documentKey) throw new Error("preview document key does not match binding document key");
      const remote = await input.larkClient.fetchFull(nodeToken); const binding = new ApiDocBindingStore(input.bindingPath ?? `${input.previewRoot}/../bindings.json`).bind({ documentKey, nodeToken, documentId: remote.documentId, lastRevisionId: remote.revisionId, sectionHashes: preview.manifest.sectionHashes, previewId, sourceRevisions: preview.manifest.revisionIds }); input.out(JSON.stringify(binding)); return 0;
    }
    if (sub === "unbind") { const documentKey = argv[1], nodeToken = value("node-token"); if (!documentKey || !nodeToken) throw new Error("unbind requires document key and --node-token"); new ApiDocBindingStore(input.bindingPath ?? `${input.previewRoot}/../bindings.json`).unbind(documentKey, nodeToken); input.out(JSON.stringify({ status: "unbound", documentKey })); return 0; }
    if (sub === "sync") {
      const previewId = argv[1]; if (!previewId || !input.larkClient) throw new Error("sync requires preview id and a configured Lark client"); const preview = loadCurrent(previewId); assertFreshPreview(preview, allowStale); const bindings = new ApiDocBindingStore(input.bindingPath ?? `${input.previewRoot}/../bindings.json`); const binding = bindings.get(preview.manifest.documentKey); if (!binding) throw new Error("canonical binding not found; bind an exact node first"); const result = await syncManagedDocument({ preview, binding, client: input.larkClient, journalDir: `${input.previewRoot}/../sync-journals` }); if (result.binding) bindings.bind(result.binding); input.out(JSON.stringify(result)); return result.status === "partial" || result.status === "conflict" ? 1 : 0;
    }
    if (sub === "draft") {
      const previewId = argv[1], parentToken = value("parent-token"); if (!previewId || !parentToken || !input.larkClient) throw new Error("draft requires preview id, --parent-token, and a configured Lark client"); const preview = store.load(previewId); const draft = await input.larkClient.createDraft({ parentToken, title: preview.ir.title, xml: preview.rendered.larkXml }); input.out(JSON.stringify({ status: "draft_created", previewId, ...draft })); return 0;
    }
    if (sub === "repair") {
      const documentKey = argv[1]; if (!documentKey || !input.larkClient) throw new Error("repair requires document key and a configured Lark client"); const bindings = new ApiDocBindingStore(input.bindingPath ?? `${input.previewRoot}/../bindings.json`); const binding = bindings.get(documentKey); if (!binding) throw new Error("canonical binding not found"); const preview = loadCurrent(binding.previewId); assertFreshPreview(preview, allowStale); const result = await syncManagedDocument({ preview, binding, client: input.larkClient, journalDir: `${input.previewRoot}/../sync-journals` }); if (result.binding) bindings.bind(result.binding); input.out(JSON.stringify(result)); return result.status === "partial" || result.status === "conflict" ? 1 : 0;
    }
    input.err("usage: penguin api-doc generate|list|show|diff"); return 2;
  } catch (error) {
    if (error instanceof ApiDocCommandError) {
      const payload = { error: { code: error.code, message: error.message, details: error.details, retryable: false } };
      input.err(input.json ? JSON.stringify(payload) : `${error.code}: ${error.message}`);
      return 1;
    }
    input.err(String((error as Error).message ?? error)); return 1;
  }
}
