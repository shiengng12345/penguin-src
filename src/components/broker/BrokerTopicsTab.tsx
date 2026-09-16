// BrokerTopicsTab — the Topics tab's composition root: the topology tree
// on the left drives which tenant/namespace the topic list on the right
// shows (task-14-brief.md, Step 1), and selecting a topic row opens its
// detail pane below the table.
//
// Owns three independent pieces of state, each already established
// elsewhere in this module and simply composed here:
//  - `useBrokerTopology` — tenant/namespace navigation (Task 4/TopologyTree).
//  - the topic list for whatever namespace is selected (Task 3/TopicTable).
//  - `useTopicDetail` for whichever topic row was last clicked
//    (Task 8/TopicDetailPanel).
//
// None of `useBrokerConnections`'s concerns apply here — this component
// only needs `connectionId`, the same way `ConnectionActions` only needs
// the slice of `useBrokerConnections`'s result it actually renders (see
// that file's header for why the connections hook itself is never
// duplicated). `BrokerTopicsTab` is this tab's single owner of topology and
// topic-detail state for the identical reason: nothing else in the app
// needs a second copy of either.
import { useCallback, useEffect, useState } from "react";
import type { Page, ResultEnvelope, TopicSummary } from "@penguin/broker-contracts";
import { useBrokerTopology } from "@/hooks/useBrokerTopology";
import { useTopicDetail } from "@/hooks/useTopicDetail";
import { listTopics } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";
import { TopologyTree } from "./TopologyTree";
import { TopicTable } from "./TopicTable";
import { TopicDetailPanel } from "./TopicDetailPanel";
import { Button } from "@/components/ui/button";

const TOPIC_PAGE_LIMIT = 25;
const EMPTY_TOPIC_PAGE: Page<TopicSummary> = { items: [], total: 0, offset: 0, limit: TOPIC_PAGE_LIMIT };

export interface TopicFetchResult {
  state: DataTableState;
  error?: string;
}

/** Reduces a `listTopics` envelope to the `(state, error)` pair the topic
 *  table renders — identical shape to `useBrokerTopology`'s internal
 *  `deriveResult`: state and error come from `data`/`warnings` alone, never
 *  from `source`, and every warning survives (joined, since `TopicTable`
 *  takes one `errorMessage` string rather than an array). See
 *  `BrokerPage.test.tsx`'s history for why this exact derivation used to be
 *  wrong (fix round 1, item 5) — `envelope.source === "cache"` looked like
 *  a reasonable staleness signal until cache hits became real and a
 *  perfectly fresh one started tripping it. */
export function deriveTopicResult(envelope: ResultEnvelope<Page<TopicSummary>>): TopicFetchResult {
  if (!envelope.data) {
    return { state: "error", error: envelope.error?.message };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", error: envelope.warnings.join(" ") };
  }
  return { state: envelope.data.items.length === 0 ? "empty" : "ready", error: undefined };
}

export interface BrokerTopicsTabProps {
  connectionId: string | null;
}

export function BrokerTopicsTab({ connectionId }: BrokerTopicsTabProps) {
  const topology = useBrokerTopology(connectionId);

  const [topicPage, setTopicPage] = useState<Page<TopicSummary>>(EMPTY_TOPIC_PAGE);
  const [topicOffset, setTopicOffset] = useState(0);
  const [topicState, setTopicState] = useState<DataTableState>("empty");
  const [topicError, setTopicError] = useState<string | undefined>(undefined);
  const [selectedTopic, setSelectedTopic] = useState<TopicSummary | null>(null);

  const { selectedTenant, selectedNamespace } = topology;

  // A newly selected namespace (or connection) starts back at page one, and
  // invalidates whatever topic detail was open — it may not even belong to
  // the namespace now on screen.
  useEffect(() => {
    setTopicOffset(0);
    setSelectedTopic(null);
  }, [connectionId, selectedTenant, selectedNamespace]);

  const fetchTopics = useCallback(async () => {
    if (!connectionId || !selectedTenant || !selectedNamespace) {
      setTopicPage(EMPTY_TOPIC_PAGE);
      setTopicError(undefined);
      setTopicState("empty");
      return;
    }
    setTopicState("loading");
    try {
      const envelope = await listTopics(connectionId, selectedTenant, selectedNamespace, {
        offset: topicOffset,
        limit: TOPIC_PAGE_LIMIT,
      });
      // Rule 3, task-14-brief.md: data and warnings can arrive together —
      // that is a partial success, not a failure, so the page is applied
      // whenever `data` is present regardless of `warnings`.
      if (envelope.data) {
        setTopicPage(envelope.data);
      }
      const result = deriveTopicResult(envelope);
      setTopicError(result.error);
      setTopicState(result.state);
    } catch (err) {
      setTopicError(err instanceof Error ? err.message : String(err));
      setTopicState("error");
    }
  }, [connectionId, selectedTenant, selectedNamespace, topicOffset]);

  useEffect(() => {
    void fetchTopics();
  }, [fetchTopics]);

  const topicDetail = useTopicDetail(connectionId, selectedTopic);

  const noNamespaceSelected = Boolean(connectionId) && (!selectedTenant || !selectedNamespace);

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="w-56 shrink-0 overflow-auto border-r border-border pr-3">
        <TopologyTree
          tenants={topology.tenants}
          namespaces={topology.namespaces}
          selectedTenant={selectedTenant}
          selectedNamespace={selectedNamespace}
          onSelectTenant={topology.selectTenant}
          onSelectNamespace={topology.selectNamespace}
          state={topology.state}
          subjects={topology.subjects}
          warnings={topology.warnings}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto">
        {noNamespaceSelected ? (
          <div
            role="status"
            className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground"
          >
            Select a tenant and namespace in the tree to see its topics.
          </div>
        ) : (
          <TopicTable
            topics={topicPage.items}
            total={topicPage.total}
            offset={topicPage.offset}
            limit={topicPage.limit}
            state={topicState}
            errorMessage={topicError}
            onPageChange={setTopicOffset}
            noActiveConnection={!connectionId}
            selectedTopicFullName={selectedTopic?.fullName ?? null}
            onSelectTopic={setSelectedTopic}
          />
        )}

        {selectedTopic && (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedTopic(null)}>
                Close
              </Button>
            </div>
            <TopicDetailPanel
              detail={topicDetail.detail}
              state={topicDetail.state}
              errorMessage={topicDetail.errorMessage}
              warnings={topicDetail.warnings}
              onRefresh={topicDetail.refresh}
            />
          </div>
        )}
      </div>
    </div>
  );
}
