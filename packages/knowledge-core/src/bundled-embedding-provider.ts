import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectLocalEmbeddingDirectory } from "./embedding-provider.js";
import { createLocalEmbeddingProvider, localEmbeddingSpaceIdentity, type LocalEmbeddingBackend, type VerifiedLocalEmbeddingProvider } from "./local-embedding-provider.js";
import type { EmbeddingSpaceIdentityResult } from "./semantic-identity.js";
import { createTransformersEmbeddingBackend, type TransformersEmbeddingBackendOptions } from "./transformers-embedding-backend.js";

export interface BundledEmbeddingProviderOptions {
  modelDirectory?: string;
  entryPath?: string;
  backend?: LocalEmbeddingBackend;
  env?: NodeJS.ProcessEnv;
  /** Measured local inference knobs; they never change model identity. */
  dtype?: string;
  device?: string;
  sessionOptions?: Record<string, unknown>;
  intraOpNumThreads?: number;
  inferenceBatchSize?: number;
  inferenceConcurrency?: number;
}

function modelDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "manifest.json")))
    .map((entry) => resolve(root, entry.name))
    .sort();
}

/** Discover exactly one bundled model from an explicit path or runtime tree. */
export function resolveBundledEmbeddingModelDirectory(options: Omit<BundledEmbeddingProviderOptions, "backend"> = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.modelDirectory ?? env.PENGUIN_EMBEDDING_MODEL_DIR?.trim();
  if (explicit) {
    const directory = resolve(explicit);
    inspectLocalEmbeddingDirectory(directory);
    return directory;
  }
  let cursor = dirname(resolve(options.entryPath ?? process.argv[1] ?? process.execPath));
  const found = new Set<string>();
  for (let depth = 0; depth < 7; depth += 1) {
    for (const directory of modelDirectories(join(cursor, "models"))) found.add(directory);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (found.size === 0) throw new Error("LOCAL_EMBEDDING_MODEL_NOT_INSTALLED");
  if (found.size > 1) throw new Error("LOCAL_EMBEDDING_MODEL_AMBIGUOUS");
  const directory = [...found][0];
  inspectLocalEmbeddingDirectory(directory);
  return directory;
}

const defaultProviders = new Map<string, Promise<VerifiedLocalEmbeddingProvider>>();

/** Resolve and verify model identity without loading ONNX weights. */
export function resolveBundledEmbeddingSpaceIdentity(
  options: Omit<BundledEmbeddingProviderOptions, "backend"> = {},
): EmbeddingSpaceIdentityResult {
  return localEmbeddingSpaceIdentity(resolveBundledEmbeddingModelDirectory(options));
}

/** Open the verified model once per process; custom backends remain uncached for tests. */
export async function openBundledEmbeddingProvider(options: BundledEmbeddingProviderOptions = {}): Promise<VerifiedLocalEmbeddingProvider> {
  const directory = resolveBundledEmbeddingModelDirectory(options);
  const descriptor = inspectLocalEmbeddingDirectory(directory);
  const backendOptions: TransformersEmbeddingBackendOptions = {
    dtype: options.dtype ?? descriptor.dtype ?? "q8",
    device: options.device ?? "cpu",
    sessionOptions: options.sessionOptions,
    intraOpNumThreads: options.intraOpNumThreads,
    inferenceBatchSize: options.inferenceBatchSize,
    inferenceConcurrency: options.inferenceConcurrency,
    documentPrefix: descriptor.documentPrefix ?? "search_document: ",
    queryPrefix: descriptor.queryPrefix ?? "search_query: ",
  };
  const create = () => createLocalEmbeddingProvider({
    directory,
    backend: options.backend ?? createTransformersEmbeddingBackend(backendOptions),
  });
  if (options.backend) return create();
  const cacheKey = directory + "|" + JSON.stringify({
    dtype: backendOptions.dtype,
    device: backendOptions.device,
    sessionOptions: backendOptions.sessionOptions ?? null,
    intraOpNumThreads: backendOptions.intraOpNumThreads ?? null,
    inferenceBatchSize: backendOptions.inferenceBatchSize ?? null,
    inferenceConcurrency: backendOptions.inferenceConcurrency ?? null,
  });
  const cached = defaultProviders.get(cacheKey);
  if (cached) return cached;
  const pending = create();
  defaultProviders.set(cacheKey, pending);
  try { return await pending; }
  catch (error) { defaultProviders.delete(cacheKey); throw error; }
}
