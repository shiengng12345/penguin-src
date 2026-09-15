// BrokerPage — the broker module's shell. Connections / Topics split, both
// driven by the ONE `useBrokerConnections` instance this component owns (see
// ConnectionActions.tsx's header for why that must not be duplicated).
//
// Follows the same page shell shape as ApiDocsPage / WikiPage: a header bar
// with a Home button, and `onClose` returning to the API Client.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Waypoints } from "lucide-react";
import type { Page, TopicSummary } from "@penguin/broker-contracts";
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
        setTopicError(envelope.warnings[0]);
        // `source: "cache"` means Admin REST failed and this is the last
        // known-good snapshot — surface that as stale rather than ready.
        setTopicState(
          envelope.source === "cache"
            ? "stale"
            : envelope.data.items.length === 0
            ? "empty"
            : "ready",
        );
      } else {
        setTopicError(envelope.error?.message);
        setTopicState("error");
      }
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
