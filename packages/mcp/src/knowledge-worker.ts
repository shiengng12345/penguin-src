import { parentPort, workerData } from "node:worker_threads";
import { KnowledgeStore } from "@penguin/knowledge-core";
import { runKnowledgeTool } from "./knowledge-tools.js";

interface WorkerRequest {
  type: "run";
  id: string;
  capabilityId: "knowledge.mcp_tool";
  input: { name: string; arguments: Record<string, unknown> };
}

if (!parentPort) throw new Error("KNOWLEDGE_WORKER_PARENT_PORT_REQUIRED");

const config = workerData as { dbPath: string; ledgerPath: string };
const store = KnowledgeStore.open({
  dbPath: config.dbPath,
  ledgerPath: config.ledgerPath,
  allowSchemaMutation: false,
});

parentPort.on("message", async (request: WorkerRequest) => {
  if (request.type !== "run" || request.capabilityId !== "knowledge.mcp_tool") return;
  try {
    const result = await runKnowledgeTool(
      request.input.name,
      request.input.arguments,
      { store },
    );
    parentPort!.postMessage({ type: "result", id: request.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      type: "result",
      id: request.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code ?? "INTERNAL",
        message: String((error as Error).message ?? error),
      },
    });
  }
});

parentPort.on("close", () => store.close());
