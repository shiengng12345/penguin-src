// packages/broker-core/src/topic-folding.ts
import type { TopicSummary } from "@penguin/broker-contracts";

const PARTITION_SUFFIX = /-partition-(\d+)$/;

function parse(fullName: string): Omit<TopicSummary, "partitions" | "partitionNames"> {
  // persistent://tenant/namespace/short
  const [scheme, rest] = fullName.split("://");
  const [tenant, namespace, ...shortParts] = (rest ?? "").split("/");
  return {
    fullName,
    shortName: shortParts.join("/"),
    tenant: tenant ?? "",
    namespace: namespace ?? "",
    persistent: scheme === "persistent",
  };
}

/**
 * Admin REST's topic list returns expanded partitions
 * (`events-partition-0..2`) while only `/partitioned` knows the logical topic
 * (`events`). Rendering the raw list shows one topic as N rows. This folds them.
 *
 * Membership is decided by the `/partitioned` list, never by the name pattern
 * alone — a topic legitimately named `my-partition-plan` must survive intact.
 */
export function foldTopics(allTopics: string[], partitionedTopics: string[]): TopicSummary[] {
  const parents = new Set(partitionedTopics);
  const byParent = new Map<string, string[]>();
  const standalone: string[] = [];

  for (const name of allTopics) {
    const match = name.match(PARTITION_SUFFIX);
    const candidateParent = match ? name.replace(PARTITION_SUFFIX, "") : null;

    if (candidateParent && parents.has(candidateParent)) {
      const list = byParent.get(candidateParent) ?? [];
      list.push(name);
      byParent.set(candidateParent, list);
    } else {
      standalone.push(name);
    }
  }

  const folded: TopicSummary[] = standalone.map((name) => ({
    ...parse(name),
    partitions: 0,
    partitionNames: [],
  }));

  for (const parent of parents) {
    const partitionNames = (byParent.get(parent) ?? []).sort((a, b) => {
      const ai = Number(a.match(PARTITION_SUFFIX)?.[1] ?? 0);
      const bi = Number(b.match(PARTITION_SUFFIX)?.[1] ?? 0);
      return ai - bi;
    });
    folded.push({ ...parse(parent), partitions: partitionNames.length, partitionNames });
  }

  return folded.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
