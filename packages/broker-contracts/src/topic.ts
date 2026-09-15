// packages/broker-contracts/src/topic.ts

/** One logical topic. A partitioned topic is ONE of these with partitions > 0,
 *  never N rows — Admin REST returns the expanded form and we fold it (V-A6). */
export interface TopicSummary {
  fullName: string;          // persistent://public/default/orders
  shortName: string;         // orders
  tenant: string;
  namespace: string;
  persistent: boolean;
  partitions: number;        // 0 = non-partitioned
  partitionNames: string[];  // expanded names, empty when partitions === 0
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PageQuery {
  offset: number;
  limit: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}
