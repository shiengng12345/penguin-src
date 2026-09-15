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
    // Rust port: this relies on Array.prototype.sort being a STABLE sort
    // (guaranteed by spec since ES2019). Use `sort_by`, not `sort_unstable_by`.
    const partitionNames = (byParent.get(parent) ?? []).sort((a, b) => {
      const ai = Number(a.match(PARTITION_SUFFIX)?.[1] ?? 0);
      const bi = Number(b.match(PARTITION_SUFFIX)?.[1] ?? 0);
      return ai - bi;
    });
    // A `/partitioned` entry with no matching expanded partitions in
    // `allTopics` (e.g. Admin REST returned it but the topic list call raced
    // or was scoped differently) still gets a row here, with partitions: 0
    // and partitionNames: []. This is deliberate: it surfaces the mismatch
    // instead of silently dropping the logical topic. The Rust port must
    // reproduce this rather than filtering such parents out.
    folded.push({ ...parse(parent), partitions: partitionNames.length, partitionNames });
  }

  // `localeCompare` is locale-aware collation, not byte order. Rust's default
  // `Ord` on `String` IS byte order. The Rust port must pick one explicitly
  // (most likely byte order, to match Rust idiom) and both sides must agree
  // on which one is "the" order, since callers may depend on it.
  // Also relies on `Array.prototype.sort`'s stability guarantee (ES2019+) —
  // Rust must use `sort_by`, not `sort_unstable_by`.
  return folded.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
