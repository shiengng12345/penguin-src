// BrokerPage — the broker module's shell. Connections / Overview / Topics
// split, all driven by the ONE `useBrokerConnections` instance this
// component owns (see `ConnectionActions.tsx`'s header for why that must
// not be duplicated).
//
// Follows the same page shell shape as ApiDocsPage / WikiPage: a header bar
// with a Home button, and `onClose` returning to the API Client.
//
// Task 14 wires the last two tabs: `BrokerOverviewTab` (the anomaly panel,
// `AnomalyPanel`/`useBrokerOverview`) and `BrokerTopicsTab` (the topology
// tree driving the topic list, plus the per-topic detail pane,
// `TopologyTree`/`TopicTable`/`TopicDetailPanel`/`useBrokerTopology`/
// `useTopicDetail`). Both own their own state — this component only hands
// them the active connection's id, the same way `ConnectionActions` is
// handed only the slice of `useBrokerConnections`'s result it renders.
// Keeping the tab bodies as siblings is what keeps this file under the
// repo's line budget as the module has grown across fourteen tasks.
import { useState } from "react";
import { ArrowLeft, Waypoints } from "lucide-react";
import { useBrokerConnections } from "@/hooks/useBrokerConnections";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConnectionActions } from "./ConnectionActions";
import { BrokerOverviewTab } from "./BrokerOverviewTab";
import { BrokerTopicsTab } from "./BrokerTopicsTab";

interface BrokerPageProps {
  onClose: () => void;
}

type BrokerTab = "connections" | "overview" | "topics";

export function BrokerPage({ onClose }: BrokerPageProps) {
  const conn = useBrokerConnections();
  const [tab, setTab] = useState<BrokerTab>("connections");
  const activeConnection = conn.connections.find((c) => c.id === conn.activeId) ?? null;
  const activeConnectionId = activeConnection?.id ?? null;

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
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "topics"} onClick={() => setTab("topics")}>
          Topics
        </TabButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {tab === "connections" && (
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
        )}
        {tab === "overview" && <BrokerOverviewTab connectionId={activeConnectionId} />}
        {tab === "topics" && <BrokerTopicsTab connectionId={activeConnectionId} />}
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
