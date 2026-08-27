import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export class LarkDocumentBindingStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
        mkdirSync(dirname(filePath), { recursive: true });
    }
    read() { if (!existsSync(this.filePath))
        return {}; try {
        const value = JSON.parse(readFileSync(this.filePath, "utf8"));
        return Object.fromEntries(Object.entries(value).map(([key, binding]) => [key, { ...binding, ...(binding.sourceRevisions ? {} : { sourceRevisions: {}, migrationState: binding.sourceCommitSha ? "legacy_repo_unknown" : undefined }), managedSectionHashes: binding.managedSectionHashes ?? {}, managedBlockIds: binding.managedBlockIds ?? {} }]));
    }
    catch {
        return {};
    } }
    write(value) { const tmp = `${this.filePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, this.filePath); }
    resolve(documentKey) { return this.read()[documentKey] ?? null; }
    listCandidates(nodes) { return [...nodes]; }
    bind(input) { if (!input.nodeToken)
        throw new Error("nodeToken is required"); if (!input.documentId)
        throw new Error("documentId is required"); if (!Number.isInteger(input.revisionId) || input.revisionId < 0)
        throw new Error("revisionId must be a non-negative integer"); const all = this.read(); const existing = all[input.documentKey]; if (existing && existing.nodeToken !== input.nodeToken)
        throw new Error(`document key already bound to ${existing.nodeToken}; unbind explicitly first`); for (const [key, binding] of Object.entries(all))
        if (key !== input.documentKey && binding.nodeToken === input.nodeToken)
            throw new Error(`node token already bound to ${key}`); const binding = { documentKey: input.documentKey, nodeToken: input.nodeToken, documentId: input.documentId, lastRevisionId: input.revisionId, sourceRevisions: input.sourceRevisions, sourceRevisionSetHash: input.sourceRevisionSetHash, managedSectionHashes: input.managedSectionHashes ?? {}, managedBlockIds: input.managedBlockIds ?? {}, verifiedAt: input.verifiedAt }; all[input.documentKey] = binding; this.write(all); return binding; }
    updateVerified(binding) { const all = this.read(); if (!all[binding.documentKey] || all[binding.documentKey].nodeToken !== binding.nodeToken)
        throw new Error("binding identity mismatch"); all[binding.documentKey] = binding; this.write(all); }
    remove(documentKey, expectedNodeToken) { const all = this.read(); if (all[documentKey] && all[documentKey].nodeToken !== expectedNodeToken)
        throw new Error("binding token mismatch"); delete all[documentKey]; this.write(all); }
}
//# sourceMappingURL=api-doc-binding-store.js.map