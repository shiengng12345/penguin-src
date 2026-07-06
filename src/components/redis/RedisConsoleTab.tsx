import { invoke } from "@tauri-apps/api/core";
import { CornerDownLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Console tab (Phase 5) — run any command; destructive commands need confirm.
// ---------------------------------------------------------------------------

interface CliResult {
  ok: boolean;
  output: string;
  needs_confirm: boolean;
}

interface Line {
  prompt: string;
  output: string;
  ok: boolean;
}

export function RedisConsoleTab({ connectionId }: { connectionId: string }): ReactElement {
  // WHY: the backend routes every command by the db passed in (it keeps no
  // session state), so a user's successful SELECT must update this local db
  // or every later command silently runs on db0.
  const [db, setDb] = useState(0);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Line[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [recall, setRecall] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // New connection starts back on db0, like a fresh redis-cli session.
  useEffect(() => {
    setDb(0);
  }, [connectionId]);

  const exec = useCallback(
    async (line: string, confirmed: boolean) => {
      const result = await invoke<CliResult>("reg_cli_exec", {
        id: connectionId,
        db,
        line,
        confirmed,
      }).catch((error) => {
        return { ok: false, output: String(error), needs_confirm: false } satisfies CliResult;
      });
      if (result.needs_confirm) {
        setPendingConfirm(line);
        setHistory((previous) => [...previous, { prompt: line, output: result.output, ok: false }]);
        return;
      }
      if (result.ok) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length === 2 && tokens[0].toUpperCase() === "SELECT") {
          const target = Number(tokens[1]);
          if (Number.isInteger(target) && target >= 0 && target <= 255) {
            setDb(target);
          }
        }
      }
      setPendingConfirm(null);
      setHistory((previous) => [...previous, { prompt: line, output: result.output, ok: result.ok }]);
    },
    [connectionId, db],
  );

  const submit = useCallback(() => {
    const line = input.trim();
    if (line === "") {
      return;
    }
    setRecall((previous) => [...previous, line]);
    setInput("");
    void exec(line, false);
  }, [input, exec]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-black/30 p-3 font-mono text-[11px] leading-relaxed">
        {history.length === 0 ? (
          <div className="text-muted-foreground">
            输入 Redis 命令回车执行，例如 <span className="text-foreground">PING</span> /{" "}
            <span className="text-foreground">SET foo bar</span> /{" "}
            <span className="text-foreground">INFO server</span>
          </div>
        ) : null}
        {history.map((line, index) => (
          <div key={index} className="mb-1">
            <div className="text-sky-400">&gt; {line.prompt}</div>
            <div className={cn("whitespace-pre-wrap break-all", line.ok ? "text-foreground/90" : "text-rose-300")}>
              {line.output}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {pendingConfirm !== null ? (
        <div className="flex items-center gap-2 border-t border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs">
          <span className="text-rose-300">危险命令 — 确认执行 “{pendingConfirm}” ?</span>
          <button
            type="button"
            onClick={() => {
              const line = pendingConfirm;
              setPendingConfirm(null);
              void exec(line, true);
            }}
            className="h-6 rounded bg-rose-500 px-2 text-white"
          >
            确认执行
          </button>
          <button
            type="button"
            onClick={() => setPendingConfirm(null)}
            className="h-6 rounded border border-border px-2 hover:bg-muted"
          >
            取消
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border/60 p-2">
        <span className="font-mono text-xs text-sky-400">{db === 0 ? ">" : `[db${db}]>`}</span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            } else if (event.key === "ArrowUp" && recall.length > 0) {
              setInput(recall[recall.length - 1]);
            }
          }}
          placeholder="输入命令…"
          className="h-7 flex-1 rounded border border-border bg-background px-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={submit}
          className="flex h-7 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
          执行
        </button>
      </div>
    </div>
  );
}
