// BrokerPage — the broker module's shell. Connections / Topics split, both
// driven by the ONE `useBrokerConnections` instance this component owns (see
// ConnectionActions.tsx's header for why that must not be duplicated).
//
// Follows the same page shell shape as ApiDocsPage / WikiPage: a header bar
// with a Home button, and `onClose` returning to the API Client.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Waypoints } from "lucide-react";
import type { Page, ResultEnvelope, TopicSummary } from "@penguin/broker-contracts";
import { useBrokerConnections } from "@/hooks/useBrokerConnections";
import { listTopics } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConnectionActions } from "./ConnectionActions";
import { TopicTable } from "./TopicTable";

interface BrokerPageProps {
  onClose: () => void;
}

type BrokerTab = "connections" | "topics";

const TOPIC_PAGE_LIMIT = 25;
const EMPTY_TOPIC_PAGE: Page<TopicSummary> = { items: [], total: 0, offset: 0, limit: TOPIC_PAGE_LIMIT };

export interface TopicFetchResult {
  state: DataTableState;
  error?: string;
}

/** Reduces a `listTopics` envelope to the `(state, error)` pair the topics
 *  tab renders — the same way `useBrokerTopology`'s `deriveResult` does:
 *  from `data` and `warnings`, never from `source` alone.
 *
 *  Fix round 1, item 5: this used to branch on `envelope.source === "cache"`
 *  to decide `"stale"`. Before Task 3, `source: "cache"` was unreachable, so
 *  that branch never actually ran. Task 3 made cache hits real, and a
 *  *fresh* cache hit also arrives as `source: "cache"` with `warnings: []`
 *  — the old code stamped a staleness banner on it anyway, presenting
 *  perfectly good data as suspect. Also fixes the mirror-image defect this
 *  hook's own `deriveResult` had before this same fix round: keeping only
 *  `warnings[0]` when the cache-read-through policy can attach more than
 *  one warning to a single response.
 *
 *  Exported so this exact derivation is unit-testable without mounting the
 *  whole page — `BrokerPage` also owns `useBrokerConnections`, whose
 *  persisted-active-connection chain reaches into the app's SQLite-backed
 *  `app_kv` bridge, which a pure state-derivation test has no business
 *  depending on. */
export function deriveTopicResult(envelope: ResultEnvelope<Page<TopicSummary>>): TopicFetchResult {
  if (!envelope.data) {
    return { state: "error", error: envelope.error?.message };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", error: envelope.warnings.join(" ") };
  }
  return { state: envelope.data.items.length === 0 ? "empty" : "ready", error: undefined };
}

export function BrokerPage({ onClose }: BrokerPageProps) {
  const conn = useBrokerConnections();
  const [tab, setTab] = useState<BrokerTab>("connections");
  const activeConnection = conn.connections.find((c) => c.id === conn.activeId) ?? null;

  const [topicPage, setTopicPage] = useState<Page<TopicSummary>>(EMPTY_TOPIC_PAGE);
  const [topicOffset, setTopicOffset] = useState(0);
  const [topicState, setTopicState] = useState<DataTableState>("empty");
  const [topicError, setTopicError] = useState<string | undefined>(undefined);

  // A newly activated connection starts back at page one — the old offset
  // may not even exist in the new connection's topic list.
  useEffect(() => {
    setTopicOffset(0);
  }, [activeConnection?.id]);

  const fetchTopics = useCallback(async () => {
    if (!activeConnection) {
      setTopicPage(EMPTY_TOPIC_PAGE);
      setTopicError(undefined);
      setTopicState("empty");
      return;
    }
    setTopicState("loading");
    try {
      const envelope = await listTopics(
        activeConnection.id,
        activeConnection.defaultTenant,
        activeConnection.defaultNamespace,
        { offset: topicOffset, limit: TOPIC_PAGE_LIMIT },
      );
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
  }, [activeConnection, topicOffset]);

  useEffect(() => {
    void fetchTopics();
  }, [fetchTopics]);

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2">
        <Waypoints className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Broker</span>
        <span className="text-[11px] text-muted-foreground">Message-queue operations console</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Home
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border px-4 pt-2" role="tablist" aria-label="Broker sections">
        <TabButton active={tab === "connections"} onClick={() => setTab("connections")}>
          Connections
        </TabButton>
        <TabButton active={tab === "topics"} onClick={() => setTab("topics")}>
          Topics
        </TabButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {tab === "connections" ? (
          <ConnectionActions
            connections={conn.connections}
            activeId={conn.activeId}
            setActive={conn.setActive}
            save={conn.save}
            remove={conn.remove}
            test={conn.test}
            state={conn.state}
            error={conn.error}
          />
        ) : (
          <TopicTable
            topics={topicPage.items}
            total={topicPage.total}
            offset={topicPage.offset}
            limit={topicPage.limit}
            state={topicState}
            errorMessage={topicError}
            onPageChange={setTopicOffset}
            noActiveConnection={!activeConnection}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-b-2 border-primary text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
