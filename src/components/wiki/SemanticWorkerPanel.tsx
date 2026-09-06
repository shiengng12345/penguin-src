import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BrainCircuit, Loader2, Pause, Play, RotateCcw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatKnowledgeError,
  knowledgeSemanticControl,
  knowledgeSemanticStatus,
  onSemanticStatusChanged,
  type SemanticControlAction,
  type SemanticGenerationState,
  type SemanticStatus,
} from "@/lib/knowledge-client";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 30_000;

const STATE_COPY: Record<SemanticGenerationState, { label: string; tone: string }> = {
  disabled: { label: "Disabled", tone: "text-muted-foreground" },
  not_queued: { label: "Not queued", tone: "text-muted-foreground" },
  chunks_ready: { label: "Preparing queue", tone: "text-cyan-300" },
  queued: { label: "Queued", tone: "text-cyan-300" },
  embedding: { label: "Embedding", tone: "text-cyan-300" },
  pausing: { label: "Pausing", tone: "text-amber-300" },
  paused: { label: "Paused", tone: "text-amber-300" },
  retry_wait: { label: "Retry waiting", tone: "text-amber-300" },
  stalled: { label: "Stalled", tone: "text-red-300" },
  active: { label: "Active", tone: "text-emerald-300" },
  superseded: { label: "Superseded", tone: "text-muted-foreground" },
  cancelled: { label: "Cancelled", tone: "text-muted-foreground" },
};

const BUSY_STATES = new Set<SemanticGenerationState>([
  "chunks_ready", "queued", "embedding", "pausing", "paused", "retry_wait",
]);

function currentByScope(statuses: SemanticStatus[]): SemanticStatus[] {
  const seen = new Set<string>();
  return statuses.filter((status) => {
    if (seen.has(status.scopeKey)) return false;
    seen.add(status.scopeKey);
    return true;
  });
}

function repoLabel(status: SemanticStatus): string {
  return status.scopeKey.startsWith("repo:") ? status.scopeKey.slice(5) : status.scopeKey;
}

function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return "less than a minute";
  if (seconds < 3600) return `about ${Math.ceil(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} hr`;
}

function heartbeatLabel(iso: string | null): string {
  if (!iso) return "no worker heartbeat yet";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "invalid heartbeat";
  return seconds < 60 ? `last heartbeat ${seconds}s ago` : `last heartbeat ${Math.floor(seconds / 60)}m ago`;
}

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.includes("MODEL_IDENTITY_MISMATCH")) return "Model version mismatch — rebuild or reinstall the matching runtime.";
  if (reason.includes("MODEL_UNAVAILABLE") || reason.includes("EMBEDDING_MODEL")) return "Embedding model unavailable — the worker will stay fail-closed.";
  return reason;
}

export function SemanticWorkerPanel() {
  const [statuses, setStatuses] = useState<SemanticStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const result = await knowledgeSemanticStatus();
      if (request !== requestRef.current) return;
      setStatuses(result.statuses);
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(formatKnowledgeError(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  const current = useMemo(() => currentByScope(statuses), [statuses]);
  const hasBackgroundWork = current.some((status) => BUSY_STATES.has(status.state));

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), hasBackgroundWork ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasBackgroundWork, refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void onSemanticStatusChanged(() => void refresh()).then((stop) => {
      if (mounted) unlisten = stop;
      else stop();
    });
    return () => { mounted = false; unlisten?.(); };
  }, [refresh]);

  const control = useCallback(async (status: SemanticStatus, action: SemanticControlAction) => {
    if (action === "cancel" && !window.confirm("Cancel this semantic generation? The currently active generation will remain available.")) return;
    const key = `${status.scopeKey}:${action}`;
    setPendingAction(key);
    setError(null);
    try {
      const result = await knowledgeSemanticControl(action, status.scopeKey, action === "retry" || action === "cancel" ? status.generationId ?? undefined : undefined);
      setStatuses((items) => [result.status, ...items.filter((item) => item.scopeKey !== result.status.scopeKey || item.generationId !== result.status.generationId)]);
      await refresh();
    } catch (cause) {
      setError(formatKnowledgeError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [refresh]);

  return (
    <section aria-label="Semantic indexing status" className="mx-4 mt-3 rounded-lg border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrainCircuit className="h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <h2 className="text-xs font-semibold text-foreground">Semantic indexing</h2>
            <p className="text-[10px] text-muted-foreground">Background worker · safe to close Penguin</p>
          </div>
        </div>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {error}
        </div>
      )}

      {!loading && current.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">No semantic generation is queued. Graph and lexical search remain available.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {current.map((status) => {
            const copy = STATE_COPY[status.state];
            const reason = reasonLabel(status.reason);
            const eta = formatEta(status.etaSeconds);
            const canPause = ["chunks_ready", "queued", "embedding", "retry_wait"].includes(status.state);
            const canResume = status.state === "paused";
            const canRetry = status.state === "stalled" || status.retryableFailed > 0 || status.terminalFailed > 0;
            const canCancel = status.generationId != null && ["chunks_ready", "queued", "embedding", "pausing", "paused", "retry_wait", "stalled"].includes(status.state);
            return (
              <article key={`${status.scopeKey}:${status.generationId ?? "none"}`} className="rounded-md border border-border/60 bg-background/40 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="max-w-[55%] truncate text-xs text-foreground" title={repoLabel(status)}>{repoLabel(status)}</strong>
                  <span className={cn("text-[11px] font-medium", copy.tone)}>{copy.label}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
                  <span>{status.ready.toLocaleString()} / {status.expected.toLocaleString()} chunks ({status.progressPercent.toFixed(1)}%)</span>
                  <span>{status.ratePerSecond != null ? `${status.ratePerSecond.toFixed(1)} chunks/s` : heartbeatLabel(status.lastHeartbeatAt)}{eta ? ` · ${eta}` : ""}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full transition-[width] duration-300", status.state === "stalled" ? "bg-red-400" : status.state === "active" ? "bg-emerald-400" : "bg-cyan-400")} style={{ width: `${Math.max(0, Math.min(100, status.progressPercent))}%` }} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className={cn("text-[10px]", reason || status.restartRequired ? "text-amber-300" : "text-muted-foreground")}>
                    {status.restartRequired ? "Runtime restart required" : reason ?? `${status.modelId ?? "Nomic model"} · sqlite-vec`}
                  </span>
                  <div className="flex flex-wrap items-center gap-1">
                    {canPause && <button type="button" disabled={pendingAction != null || status.state === "pausing"} onClick={() => void control(status, "pause")} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-40"><Pause className="h-3 w-3" />Pause</button>}
                    {canResume && <button type="button" disabled={pendingAction != null} onClick={() => void control(status, "resume")} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-40"><Play className="h-3 w-3" />Resume</button>}
                    {canRetry && <button type="button" disabled={pendingAction != null || !status.generationId} onClick={() => void control(status, "retry")} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-40"><RotateCcw className="h-3 w-3" />Retry failed</button>}
                    {canCancel && <button type="button" disabled={pendingAction != null} onClick={() => void control(status, "cancel")} className="flex items-center gap-1 rounded border border-red-500/30 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"><XCircle className="h-3 w-3" />Cancel generation</button>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
