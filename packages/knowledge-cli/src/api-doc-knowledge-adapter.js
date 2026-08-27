import { resolveRevisionContext, search } from "@penguin/knowledge-core";
function jsonObject(value) { try {
    return value && typeof value === "object" ? value : JSON.parse(String(value ?? "{}"));
}
catch {
    return {};
} }
function fields(value, revisionId, source) {
    if (!Array.isArray(value))
        return [];
    return value.map((field) => { const item = jsonObject(field); return { path: String(item.path ?? item.name ?? ""), name: String(item.name ?? item.path ?? ""), type: String(item.type ?? "unknown"), presence: item.presence === "optional" ? "optional" : item.presence === "implicit" ? "implicit" : "required", repeated: item.repeated === true, ...(item.description ? { description: String(item.description) } : {}), ...(item.fields ? { fields: fields(item.fields, revisionId, source) } : {}), evidenceIds: [`schema:${source}:${revisionId}:${String(item.path ?? item.name ?? "field")}`] }; });
}
function endpointMeta(store, nodeId) { const node = store.getNode(nodeId); return jsonObject(node?.meta); }
export function createKnowledgeApiDocAdapter(store) {
    return {
        async resolveSubjects(subjects) {
            const candidates = [];
            for (const subject of subjects) {
                const rows = store.db.prepare("SELECT id,identity_key,repo_id,title,meta FROM nodes WHERE node_type='endpoint' ORDER BY identity_key").all();
                for (const row of rows) {
                    const meta = jsonObject(row.meta);
                    const service = String(meta.service ?? "");
                    const method = String(meta.method ?? "");
                    const route = String(meta.route ?? meta.path ?? row.title);
                    if (subject.repo && row.repo_id && !store.resolveRepoIds(subject.repo).includes(row.repo_id))
                        continue;
                    if (subject.service && service.toLowerCase() !== subject.service.toLowerCase())
                        continue;
                    if (subject.method && method.toLowerCase() !== subject.method.toLowerCase())
                        continue;
                    if (subject.route && route !== subject.route)
                        continue;
                    candidates.push({ subjectId: row.id, identityKey: row.identity_key, repoId: row.repo_id ?? "", repo: row.repo_id ? String(store.db.prepare("SELECT name FROM repos WHERE id=?").get(row.repo_id)?.name ?? row.repo_id) : "global", endpointKey: row.identity_key, service, method, route, protocol: String(meta.protocol ?? "grpc") });
                }
            }
            const unique = [...new Map(candidates.map((item) => [item.identityKey, item])).values()];
            if (unique.length === 1)
                return { status: "resolved", subjects: unique };
            if (!unique.length)
                return { status: "not_found", candidates: [], reason: "No indexed endpoint matched the requested subject." };
            return { status: "ambiguous_subject", candidates: unique.slice(0, 50), reason: "Multiple indexed endpoints matched; specify repo, service, method, or route." };
        },
        async resolveRevisions(request, subjects) {
            const repoIds = [...new Set(subjects.map((subject) => subject.repoId).filter(Boolean))];
            const revisions = [];
            for (const repoId of repoIds) {
                const repo = String(store.db.prepare("SELECT name FROM repos WHERE id=?").get(repoId)?.name ?? repoId);
                const selector = { repoId, ...(request.revision.commits?.[repoId] ? { commitSha: request.revision.commits[repoId] } : request.revision.commitSha ? { commitSha: request.revision.commitSha } : {}), ...(request.revision.branches?.[repoId] ? { branch: request.revision.branches[repoId] } : request.revision.branch ? { branch: request.revision.branch } : {}) };
                const resolution = resolveRevisionContext(store, selector);
                if (resolution.status !== "resolved")
                    throw new Error(`${repo}: ${resolution.reason}`);
                const context = resolution.context;
                revisions.push({ revisionId: `${repoId}:${context.snapshotId}`, repoId, repo, branch: context.branch, commitSha: context.commitSha, snapshotId: context.snapshotId, ...(context.mergeBaseSha ? { mergeBaseSha: context.mergeBaseSha } : {}), ...(context.worktreeFingerprint ? { worktreeFingerprint: context.worktreeFingerprint } : {}), trust: context.trust, resolutionSource: request.revision.commitSha ? "commit" : request.revision.branch ? "branch" : "indexed_commit", ...(context.degradationReason ? { degradationReason: context.degradationReason } : {}) });
            }
            return revisions;
        },
        async collectEndpoint(subject, revision) {
            const node = store.db.prepare("SELECT id,meta FROM nodes WHERE identity_key=? LIMIT 1").get(subject.endpointKey);
            const meta = node ? endpointMeta(store, node.id) : {};
            const requestFields = fields(meta.requestFields ?? meta.request_fields, revision.revisionId, "request");
            const responseFields = fields(meta.responseFields ?? meta.response_fields, revision.revisionId, "response");
            const gaps = [];
            if (!requestFields.length)
                gaps.push({ gapId: `gap_request_schema_${subject.endpointKey}`, code: "request_schema_unavailable", message: "The indexed endpoint has no complete request field schema.", endpointKey: subject.endpointKey, revisionId: revision.revisionId, evidenceIds: [] });
            if (!responseFields.length)
                gaps.push({ gapId: `gap_response_schema_${subject.endpointKey}`, code: "response_schema_unavailable", message: "The indexed endpoint has no complete response field schema.", endpointKey: subject.endpointKey, revisionId: revision.revisionId, evidenceIds: [] });
            return { endpointKey: subject.endpointKey, revisionId: revision.revisionId, service: subject.service, method: subject.method, route: subject.route, protocol: subject.protocol, description: String(meta.description ?? ""), requestFields, responseFields, enums: Array.isArray(meta.enums) ? meta.enums : [], schemaGaps: gaps, evidenceIds: [`endpoint:${subject.endpointKey}:${revision.revisionId}`] };
        },
        async collectRequestConstraints(subject, revision) { return [{ constraintId: `constraint_schema_${subject.endpointKey}`, endpointKey: subject.endpointKey, kind: "presence", description: "Schema-derived presence constraints; detailed business guards require source analysis.", validPartitions: [], invalidPartitions: [], preconditions: [], expectedOutcomeClassIds: [], sideEffectRisk: "unknown", evidenceIds: [`constraint:${subject.endpointKey}:${revision.revisionId}`] }]; },
        async collectResponseProducers() { return []; },
        async collectCodeFacts() { return []; },
        async collectTestFacts() { return []; },
        async collectWikiFacts(subject, revision) { return search(store, subject.method || subject.service, { type: ["note"], includeSensitive: true, limit: 10 }).map((hit) => ({ factId: `wiki:${hit.identityKey}`, revisionId: revision.revisionId, status: "reviewed", statement: hit.snippet ?? hit.title, examples: [], evidenceIds: [`wiki:${hit.identityKey}`] })); },
        async collectEvents() { return []; },
        async collectChecklistFacts() { return []; },
        async collectRuntimeEvidence() { return { status: "unavailable", observations: [], evidence: [], gaps: [] }; },
    };
}
//# sourceMappingURL=api-doc-knowledge-adapter.js.map