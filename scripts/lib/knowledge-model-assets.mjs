import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

function safeRelativeAssetPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function within(root, relativePath) {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) throw new Error("PINNED_MODEL_ASSET_PATH_INVALID");
  return candidate;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Verify every pinned byte before publishing an immutable local model tree. */
export function materializePinnedEmbeddingModel({ selection, cacheDirectory, outputDirectory }) {
  if (!selection || selection.providerId !== "local" || selection.runtimeDownloadAllowed !== false || !Array.isArray(selection.assets) || selection.assets.length < 2) {
    throw new Error("PINNED_MODEL_SELECTION_INVALID");
  }
  const assets = selection.assets.map((asset) => {
    if (!safeRelativeAssetPath(asset.path) || !/^[a-f0-9]{64}$/.test(String(asset.sha256)) || !Number.isInteger(asset.bytes) || asset.bytes <= 0) throw new Error("PINNED_MODEL_ASSET_MANIFEST_INVALID");
    const source = within(cacheDirectory, asset.path);
    let size;
    try { size = statSync(source).size; } catch { throw new Error(`PINNED_MODEL_ASSET_MISSING:${asset.path}`); }
    if (size !== asset.bytes) throw new Error(`PINNED_MODEL_ASSET_SIZE_MISMATCH:${asset.path}`);
    if (digest(source) !== asset.sha256) throw new Error(`PINNED_MODEL_ASSET_HASH_MISMATCH:${asset.path}`);
    return { ...asset, source };
  });
  const modelAsset = assets.find((asset) => asset.path === selection.modelFile);
  const tokenizerAsset = assets.find((asset) => asset.path === selection.tokenizerFile);
  if (!modelAsset || !tokenizerAsset) throw new Error("PINNED_MODEL_PRIMARY_ASSET_MISSING");

  const destination = resolve(outputDirectory);
  if (destination === resolve(sep) || dirname(destination) === destination) throw new Error("PINNED_MODEL_OUTPUT_INVALID");
  const staging = `${destination}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const asset of assets) {
      const target = within(staging, asset.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(asset.source, target);
    }
    const manifest = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelFile: selection.modelFile,
      weightsDigest: modelAsset.sha256,
      tokenizerFile: selection.tokenizerFile,
      tokenizerDigest: tokenizerAsset.sha256,
      dimensions: selection.dimensions,
      maxTokens: selection.maxTokens,
      pooling: selection.pooling,
      normalization: selection.normalization,
      license: selection.license,
      sourceRevision: selection.revision,
      dtype: selection.dtype,
      documentPrefix: selection.documentPrefix,
      queryPrefix: selection.queryPrefix,
      runtimeDownloadAllowed: false,
      assetDigests: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256])),
    };
    // Tauri's build script stages resources repeatedly in the same Cargo OUT
    // directory. A read-only source manifest makes the staged copy read-only,
    // so the next build cannot overwrite it and fails with EACCES.
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
    return { outputDirectory: destination, assetCount: assets.length, modelBytes: modelAsset.bytes };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
