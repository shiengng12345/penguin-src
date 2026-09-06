export type EndpointProvenanceKind = "definition" | "client" | "handler" | "test";

export interface EndpointOccurrence {
  provenanceKind: EndpointProvenanceKind;
  repoId: string;
  commit: string;
  snapshot: string;
  file: string;
  line: number;
  endLine?: number;
  locatorNodeId?: string;
}

const ENDPOINT_OCCURRENCE_RANK: Readonly<Record<EndpointProvenanceKind, number>> = {
  handler: 0,
  definition: 1,
  client: 2,
  test: 3,
};

export function endpointOccurrenceRank(kind: EndpointProvenanceKind): number {
  return ENDPOINT_OCCURRENCE_RANK[kind];
}

export function classifyEndpointProvenanceKind(input: {
  edgeType: "handles" | "declares" | "invokes";
  filePath: string;
}): EndpointProvenanceKind {
  const normalized = input.filePath.replaceAll("\\", "/").toLowerCase();
  const testPath = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)/u.test(normalized)
    || /(?:^|\.)(?:spec|test)\.[^/]+$/u.test(normalized);
  if (testPath) return "test";
  if (input.edgeType === "handles") return "handler";
  if (input.edgeType === "declares") return "definition";
  return "client";
}

export function compareEndpointOccurrences(
  left: EndpointOccurrence,
  right: EndpointOccurrence,
): number {
  return endpointOccurrenceRank(left.provenanceKind) - endpointOccurrenceRank(right.provenanceKind)
    || left.repoId.localeCompare(right.repoId)
    || left.commit.localeCompare(right.commit)
    || left.snapshot.localeCompare(right.snapshot)
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || (left.locatorNodeId ?? "").localeCompare(right.locatorNodeId ?? "");
}

export interface EndpointInventoryFilter {
  repo?: string;
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  protocol?: string;
  service?: string;
  method?: string;
  path?: string;
  handledOnly?: boolean;
  provenanceKind?: EndpointProvenanceKind;
  limit: number;
  cursor?: string;
}

export interface EndpointPublicationExclusion {
  endpointId?: string;
  discoveryKey: string;
  reasonCode: string;
  candidateEndpointIds: string[];
  provenance: { provenanceKind: EndpointProvenanceKind; filePath: string; startLine?: number };
}

export interface EndpointPublicationReceipt {
  discovered: number;
  persisted: number;
  queryable: number;
  excluded: EndpointPublicationExclusion[];
  totalIsExact: boolean;
}
