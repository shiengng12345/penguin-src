import { cpus } from "node:os";
import { dirname } from "node:path";
import type { LocalEmbeddingDescriptor } from "./embedding-provider.js";
import type { LocalEmbeddingBackend } from "./local-embedding-provider.js";

interface TransformersEnvironment {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  useFSCache?: boolean;
  localModelPath?: string;
}

interface FeatureExtractionOutput {
  tolist(): unknown;
}

type FeatureExtractor = (
  texts: string | string[],
  options: { pooling: "mean"; normalize: false },
) => Promise<FeatureExtractionOutput>;

export interface TransformersEmbeddingModule {
  env: TransformersEnvironment;
  pipeline(
    task: "feature-extraction",
    model: string,
    options: {
      dtype: string;
      local_files_only: true;
      device: string;
      session_options: Record<string, unknown>;
    },
  ): Promise<FeatureExtractor>;
}

export interface TransformersEmbeddingBackendOptions {
  moduleLoader?: () => Promise<TransformersEmbeddingModule>;
  dtype?: string;
  /** Keep the device explicit so a release cannot silently fall back to an unknown backend. */
  device?: string;
  /** Override ONNX Runtime session options for a measured target machine. */
  sessionOptions?: Record<string, unknown>;
  /** Number of intra-op CPU workers; defaults to a capped count based on the host and concurrency. */
  intraOpNumThreads?: number;
  /** Maximum number of documents sent to one ONNX call. */
  inferenceBatchSize?: number;
  /** Number of bounded ONNX calls allowed to run concurrently. */
  inferenceConcurrency?: number;
  documentPrefix?: string;
  queryPrefix?: string;
}

async function loadTransformersModule(): Promise<TransformersEmbeddingModule> {
  // Keep the heavyweight native runtime out of normal MCP startup. An
  // indirect import prevents application bundlers from eagerly evaluating
  // Transformers/ONNX before a semantic operation actually requests it.
  const importModule = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return await importModule("@huggingface/transformers") as TransformersEmbeddingModule;
}

function vectorsFromOutput(output: FeatureExtractionOutput, expectedCount: number): Float32Array[] {
  const rows = output?.tolist?.();
  if (!Array.isArray(rows) || rows.length !== expectedCount || rows.some((row) => !Array.isArray(row) || row.length === 0 || row.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new Error("TRANSFORMERS_EMBEDDING_OUTPUT_INVALID");
  }
  return rows.map((row) => Float32Array.from(row as number[]));
}

/**
 * Load a bundled Transformers.js model without network or shared cache access.
 * Retrieval roles remain explicit because models such as Nomic use different
 * prompts for indexed documents and incoming search queries.
 */
export function createTransformersEmbeddingBackend(options: TransformersEmbeddingBackendOptions = {}): LocalEmbeddingBackend {
  const moduleLoader = options.moduleLoader ?? loadTransformersModule;
  const documentPrefix = options.documentPrefix ?? "search_document: ";
  const queryPrefix = options.queryPrefix ?? "search_query: ";
  const inferenceBatchSize = options.inferenceBatchSize ?? 64;
  const inferenceConcurrency = options.inferenceConcurrency ?? 2;
  if (!Number.isInteger(inferenceBatchSize) || inferenceBatchSize < 1) throw new Error("TRANSFORMERS_INFERENCE_BATCH_SIZE_INVALID");
  if (!Number.isInteger(inferenceConcurrency) || inferenceConcurrency < 1) throw new Error("TRANSFORMERS_INFERENCE_CONCURRENCY_INVALID");
  const intraOpNumThreads = options.intraOpNumThreads
    ?? Math.max(1, Math.min(8, Math.floor(cpus().length / inferenceConcurrency)));
  if (!Number.isInteger(intraOpNumThreads) || intraOpNumThreads < 1) throw new Error("TRANSFORMERS_THREAD_COUNT_INVALID");
  return {
    async load(descriptor: LocalEmbeddingDescriptor) {
      const transformers = await moduleLoader();
      transformers.env.allowRemoteModels = false;
      transformers.env.allowLocalModels = true;
      transformers.env.useFSCache = false;
      transformers.env.localModelPath = dirname(descriptor.directory);
      const extractor = await transformers.pipeline("feature-extraction", descriptor.directory, {
        dtype: options.dtype ?? "q8",
        local_files_only: true,
        device: options.device ?? "cpu",
        session_options: {
          intraOpNumThreads,
          interOpNumThreads: 1,
          executionMode: "parallel",
          ...options.sessionOptions,
        },
      });
      const inferOne = async (texts: string[]): Promise<Float32Array[]> => {
        if (texts.length === 0) return [];
        const output = await extractor(texts, { pooling: "mean", normalize: false });
        return vectorsFromOutput(output, texts.length);
      };
      const infer = async (texts: string[]): Promise<Float32Array[]> => {
        if (texts.length <= inferenceBatchSize) return inferOne(texts);
        const vectors: Float32Array[] = [];
        const waveSize = inferenceBatchSize * inferenceConcurrency;
        for (let offset = 0; offset < texts.length; offset += waveSize) {
          const wave = [];
          for (let start = offset; start < Math.min(texts.length, offset + waveSize); start += inferenceBatchSize) {
            wave.push(inferOne(texts.slice(start, Math.min(texts.length, start + inferenceBatchSize))));
          }
          const completed = await Promise.all(wave);
          vectors.push(...completed.flat());
        }
        return vectors;
      };
      const embedDocuments = (texts: string[]): Promise<Float32Array[]> => infer(texts.map((text) => `${documentPrefix}${text}`));
      const embedQuery = async (text: string): Promise<Float32Array> => {
        const vector = (await infer([`${queryPrefix}${text}`]))[0];
        if (!vector) throw new Error("TRANSFORMERS_EMBEDDING_OUTPUT_INVALID");
        return vector;
      };
      return {
        embed: embedDocuments,
        embedDocuments,
        embedQuery,
        async health() { return { ok: true }; },
      };
    },
  };
}
