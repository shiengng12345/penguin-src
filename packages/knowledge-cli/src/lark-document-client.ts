import { spawn } from "node:child_process";
import type { LarkDocumentSnapshot, LarkSectionClient } from "@penguin/api-doc-generator";
import type { ManagedBlockInput } from "@penguin/api-doc-generator";

export interface LarkProcessResult { code: number | null; stdout: string; stderr: string }
export interface LarkProcessRunner { run(argv: string[], stdin?: string): Promise<LarkProcessResult> }

const MAX_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export function createLarkProcessRunner(): LarkProcessRunner {
  return {
    run(argv, stdin) {
      return new Promise((resolve, reject) => {
        const child = spawn("lark-cli", argv, {
          shell: false,
          env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
        });
        let stdout = "", stderr = "", settled = false;
        const finish = (result: LarkProcessResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error("lark-cli timed out after 60 seconds")); }, TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer | string) => { stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT); });
        child.stderr.on("data", (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT); });
        child.on("error", fail);
        child.on("close", (code) => finish({ code, stdout, stderr }));
        if (stdin != null) { child.stdin.write(stdin); child.stdin.end(); }
      });
    },
  };
}

function jsonEnvelope(result: LarkProcessResult): Record<string, any> {
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(result.stdout) as Record<string, any>; }
  catch { throw new Error(`lark-cli returned non-JSON output: ${result.stderr.slice(0, 1000)}`); }
  if (result.code === 10 || parsed.error?.type === "confirmation_required") {
    const error = new Error(parsed.error?.message ?? "Lark confirmation required");
    (error as Error & { code?: number; detail?: unknown }).code = 10;
    (error as Error & { detail?: unknown }).detail = parsed.error ?? parsed;
    throw error;
  }
  if (result.code !== 0 || parsed.ok === false) throw new Error(parsed.error?.message ?? (result.stderr.slice(0, 1000) || `lark-cli exited ${result.code}`));
  return parsed;
}

function documentOf(envelope: Record<string, any>): Record<string, any> {
  return envelope.data?.document ?? envelope.document ?? {};
}

// lark-cli full XML annotates document blocks with id attributes. We preserve
// each top-level block as an opaque XML slice; the marker parser only needs
// stable IDs and exact block XML, while the write path always refetches IDs.
function blocksFromXml(xml: string): ManagedBlockInput[] {
  const starts = [...xml.matchAll(/<([A-Za-z][\w:-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  if (!starts.length) return [{ blockId: "document", topLevelIndex: 0, xml }];
  return starts.map((match, index) => ({ blockId: match[2], topLevelIndex: index, xml: xml.slice(match.index!, starts[index + 1]?.index ?? xml.length) }));
}

function markerContent(xml: string): string {
  return xml
    .replace(/^<p\b[^>]*>PENGUIN_API_DOC_BEGIN:[^<]*<\/p>/, "")
}

function newBlocks(envelope: Record<string, any>): number { return Number(documentOf(envelope).revision_id ?? envelope.data?.revision_id ?? 0); }

export class LarkCliDocumentClient implements LarkSectionClient {
  constructor(private readonly runner: LarkProcessRunner) {}

  private async call(argv: string[], stdin?: string): Promise<Record<string, any>> {
    return jsonEnvelope(await this.runner.run([...argv, "--format", "json", "--as", "user"], stdin));
  }

  async fetchFull(nodeToken: string, revisionId?: number): Promise<LarkDocumentSnapshot> {
    const envelope = await this.call(["docs", "+fetch", "--doc", nodeToken, "--scope", "full", "--detail", "full", "--doc-format", "xml", "--revision-id", String(revisionId ?? -1)]);
    const document = documentOf(envelope);
    return { nodeToken, documentId: String(document.document_id ?? document.documentId ?? nodeToken), revisionId: Number(document.revision_id ?? document.revisionId ?? 0), blocks: blocksFromXml(String(document.content ?? "")) };
  }

  async replaceSection(input: { nodeToken: string; sectionKey: string; xml: string; revisionId: number }): Promise<{ revisionId: number }> {
    const current = await this.fetchFull(input.nodeToken, input.revisionId);
    const markerBlock = current.blocks.find((block) => block.xml.includes(`PENGUIN_API_DOC_BEGIN:v1:`) && block.xml.includes(`:${input.sectionKey}`));
    const oldSection = markerBlock ? current.blocks.slice(current.blocks.indexOf(markerBlock)).find((block) => block.xml.includes(`PENGUIN_API_DOC_END:v1:`)) : undefined;
    const content = markerContent(input.xml);
    const anchor = markerBlock?.blockId ?? "-1";
    const inserted = await this.call(["docs", "+update", "--doc", input.nodeToken, "--command", "block_insert_after", "--block-id", anchor, "--revision-id", String(current.revisionId), "--content", "-"], content);
    const insertedRevision = newBlocks(inserted) || current.revisionId;
    if (markerBlock && oldSection) {
      const latest = await this.fetchFull(input.nodeToken, insertedRevision);
      const ids = [markerBlock.blockId, ...current.blocks.slice(current.blocks.indexOf(markerBlock) + 1, current.blocks.indexOf(oldSection) + 1).map((block) => block.blockId)];
      const deleted = await this.call(["docs", "+update", "--doc", input.nodeToken, "--command", "block_delete", "--block-id", ids.join(","), "--revision-id", String(latest.revisionId)]);
      return { revisionId: newBlocks(deleted) || latest.revisionId };
    }
    return { revisionId: insertedRevision };
  }

  async deleteSection(input: { nodeToken: string; sectionKey: string; blockIds: string[]; revisionId: number }): Promise<{ revisionId: number }> {
    const envelope = await this.call(["docs", "+update", "--doc", input.nodeToken, "--command", "block_delete", "--block-id", input.blockIds.join(","), "--revision-id", String(input.revisionId)]);
    return { revisionId: newBlocks(envelope) || input.revisionId };
  }

  async createDraft(input: { parentToken: string; title: string; xml: string }): Promise<{ nodeToken: string; revisionId: number }> {
    const envelope = await this.call(["docs", "+create", "--parent-token", input.parentToken, "--title", input.title, "--doc-format", "xml", "--content", "-"], input.xml);
    const document = documentOf(envelope);
    return { nodeToken: String(document.document_id ?? document.documentId ?? document.token), revisionId: Number(document.revision_id ?? document.revisionId ?? 0) };
  }
}
