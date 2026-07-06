import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Radio, Send, Square, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pub/Sub tab (Phase 4) — subscribe (live table) + publish (Tiny RDM layout).
// ---------------------------------------------------------------------------

const MAX_ROWS = 1000;

interface Row {
  time: string;
  channel: string;
  message: string;
}

export function RedisPubSubTab({ connectionId }: { connectionId: string }): ReactElement {
  const [channel, setChannel] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [pubChannel, setPubChannel] = useState("");
  const [pubMessage, setPubMessage] = useState("");
  // WHY: the subscription belongs to the connection it was started on —
  // switching connections (or unmounting) must stop THAT stream and reset
  // the button, or "取消订阅" would target the wrong connection.
  const subscribedIdRef = useRef<string | null>(null);

  useEffect(() => {
    setSubscribed(false);
    return () => {
      const startedId = subscribedIdRef.current;
      if (startedId !== null) {
        subscribedIdRef.current = null;
        void invoke("reg_pubsub_stop", { id: startedId }).catch(() => {});
      }
    };
  }, [connectionId]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<string>(`redis://pubsub/${connectionId}`, (event) => {
      const payload = event.payload;
      // WHY: backend emits "[channel] message" for data, plain text for status.
      const match = payload.match(/^\[(.+?)\] ([\s\S]*)$/);
      const row: Row = match
        ? { time: new Date().toLocaleTimeString(), channel: match[1], message: match[2] }
        : { time: new Date().toLocaleTimeString(), channel: "—", message: payload };
      setRows((previous) => {
        const next = [...previous, row];
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten !== null) {
        unlisten();
      }
    };
  }, [connectionId]);

  const toggle = useCallback(async () => {
    if (subscribed) {
      await invoke("reg_pubsub_stop", { id: connectionId }).catch(() => {});
      subscribedIdRef.current = null;
      setSubscribed(false);
      return;
    }
    if (channel.trim() === "") {
      return;
    }
    try {
      await invoke("reg_pubsub_start", { id: connectionId, channel: channel.trim() });
      subscribedIdRef.current = connectionId;
      setSubscribed(true);
    } catch (error) {
      setRows((previous) => [
        ...previous,
        { time: new Date().toLocaleTimeString(), channel: "—", message: `订阅失败: ${String(error)}` },
      ]);
    }
  }, [subscribed, channel, connectionId]);

  const publish = useCallback(async () => {
    if (pubChannel.trim() === "") {
      return;
    }
    await invoke("reg_publish", {
      id: connectionId,
      channel: pubChannel.trim(),
      message: pubMessage,
    }).catch(() => {});
    setPubMessage("");
  }, [connectionId, pubChannel, pubMessage]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <input
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          placeholder="频道（支持 * 模式）"
          disabled={subscribed}
          className="h-7 w-56 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void toggle()}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs",
            subscribed
              ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
          )}
        >
          {subscribed ? <Square className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
          {subscribed ? "取消订阅" : "Subscribe"}
        </button>
        <button
          type="button"
          onClick={() => setRows([])}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted"
          title="清空"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground">
            <tr className="border-b border-border/60">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-border/40 align-top hover:bg-muted/50">
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">{row.time}</td>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-sky-400">{row.channel}</td>
                <td className="px-3 py-1.5 font-mono break-all">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">No Data</div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">Received {rows.length} messages</span>
        <input
          value={pubChannel}
          onChange={(event) => setPubChannel(event.target.value)}
          placeholder="Channel"
          className="h-7 w-40 rounded border border-border bg-background px-2 text-xs"
        />
        <input
          value={pubMessage}
          onChange={(event) => setPubMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void publish();
            }
          }}
          placeholder="Message"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void publish()}
          className="flex h-7 items-center gap-1 rounded bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90"
        >
          <Send className="h-3.5 w-3.5" />
          Publish
        </button>
      </div>
    </div>
  );
}
