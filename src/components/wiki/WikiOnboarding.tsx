import { useCallback, useEffect, useState } from "react";
import { Database, FolderOpen, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatKnowledgeError,
  knowledgeAgentGuidanceSetup,
  knowledgeAgentHookSetup,
  knowledgeCliSetup,
  knowledgeCliStatus,
  knowledgeReindex,
  mcpInstallToLocalClients,
  onIndexProgress,
} from "@/lib/knowledge-client";

// Full-screen teaching page shown while the knowledge base is empty (no DB or
// zero repos). Replaces ALL wiki chrome. Primary path is one-click: native
// folder picker → in-app index (knowledge_reindex) with live progress; the
// terminal command stays as the secondary path. Polling flips into the wiki
// automatically once repos > 0.
export function WikiOnboarding({ onRefresh, onClose }: { onRefresh: () => void; onClose: () => void }) {
  const [indexing, setIndexing] = useState<{ dir: string; done: number; total: number; file: string } | null>(null);
  const [obError, setObError] = useState<string | null>(null);
  // One-click AI integration: penguin command on PATH + MCP into Claude/Codex +
  // global CLAUDE.md/AGENTS.md guidance. `done` carries the per-item summary.
  const [cliReady, setCliReady] = useState<boolean | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [hookSessionStart, setHookSessionStart] = useState(false);
  const [hookPromptSubmit, setHookPromptSubmit] = useState(false);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookResult, setHookResult] = useState<{ state: "ok" | "warn" | "fail"; text: string } | null>(null);
  // Per-item outcome — machines differ (shell, which AI clients are installed,
  // node present or not), so each step runs independently and reports honestly:
  // ok / skipped / failed, never one blanket success or one blanket error.
  const [aiResults, setAiResults] = useState<Array<{ state: "ok" | "warn" | "fail"; text: string }> | null>(null);

  useEffect(() => {
    knowledgeCliStatus()
      .then((s) => setCliReady(s.installed && s.on_path))
      .catch(() => setCliReady(null));
  }, []);

  const setupAi = useCallback(async () => {
    setAiBusy(true);
    const results: Array<{ state: "ok" | "warn" | "fail"; text: string }> = [];
    try {
      const cli = await knowledgeCliSetup();
      if (cli.manual_hint) {
        results.push({ state: "warn", text: `penguin 命令已安装 — ${cli.manual_hint}` });
      } else {
        const rc = cli.shell === "fish" ? "config.fish" : cli.shell === "bash" ? "~/.bashrc" : "~/.zshrc";
        results.push({
          state: "ok",
          text: `penguin 命令 — ${cli.rc_updated ? `已写入 ${rc},新开一个终端生效` : "已可用"}`,
        });
        setCliReady(true);
      }
    } catch (e) {
      results.push({ state: "fail", text: `penguin 命令:${formatKnowledgeError(e)}` });
    }
    try {
      const msg = await mcpInstallToLocalClients();
      const skipped = msg.match(/Skipped \(not installed\): ([^.]+)\./)?.[1];
      results.push({
        state: "ok",
        text: `MCP 已接入(重启客户端生效)${skipped ? ` — 未安装已跳过:${skipped}` : ""}`,
      });
    } catch (e) {
      results.push({ state: "fail", text: `MCP:${formatKnowledgeError(e)}` });
    }
    try {
      const g = await knowledgeAgentGuidanceSetup();
      if (g.written.length > 0) {
        results.push({
          state: "ok",
          text: `AI 指引已写入 ${g.written.map((p) => p.replace(/^.*\/(\.\w+)/, "$1")).join("、")}${g.skipped.length ? ` — 未安装已跳过:${g.skipped.join("、")}` : ""}`,
        });
      } else if (g.skipped.length > 0) {
        results.push({ state: "warn", text: `AI 指引:未检测到 Claude Code / Codex,已全部跳过` });
      } else {
        results.push({ state: "ok", text: "AI 指引已是最新" });
      }
    } catch (e) {
      results.push({ state: "fail", text: `AI 指引:${formatKnowledgeError(e)}` });
    }
    setAiResults(results);
    setAiBusy(false);
  }, []);

  const applyHooks = useCallback(async () => {
    setHookBusy(true);
    setHookResult(null);
    try {
      const hooks = await knowledgeAgentHookSetup(hookSessionStart, hookPromptSubmit);
      if (!hooks.supported) {
        setHookResult({ state: "warn", text: "Claude Code hooks:未检测到客户端,已跳过" });
      } else if (hooks.enabled.length === 0) {
        setHookResult({
          state: "ok",
          text: hooks.written ? "Penguin hooks 已移除" : "Penguin hooks 已是关闭状态",
        });
      } else {
        setHookResult({
          state: "ok",
          text: `Claude Code hooks ${hooks.written ? "已更新" : "已是最新"}:${hooks.enabled.join("、")}`,
        });
      }
    } catch (e) {
      setHookResult({ state: "fail", text: `Claude Code hooks:${formatKnowledgeError(e)}` });
    } finally {
      setHookBusy(false);
    }
  }, [hookPromptSubmit, hookSessionStart]);

  const pickAndIndex = useCallback(async () => {
    setObError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "选择要索引的代码仓库" });
    if (typeof dir !== "string") return; // cancelled
    setIndexing({ dir, done: 0, total: 0, file: "" });
    const unlisten = await onIndexProgress((p) => {
      if (p.phase !== "scan" && p.phase !== "index") return;
      setIndexing((cur) => (cur ? { ...cur, done: p.done ?? 0, total: p.total ?? 0, file: p.file ?? "" } : cur));
    });
    try {
      await knowledgeReindex(dir);
      onRefresh(); // repos > 0 now — parent flips into the wiki
    } catch (e) {
      setObError(formatKnowledgeError(e));
    } finally {
      unlisten();
      setIndexing(null);
    }
  }, [onRefresh]);

  const step = "flex gap-3 rounded-xl border border-border bg-background/50 p-4";
  const num = "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-xs font-bold text-cyan-300";
  const pct = indexing && indexing.total > 0 ? Math.round((indexing.done / indexing.total) * 100) : 0;
  return (
    <div className="relative flex h-full flex-col items-center justify-center bg-background px-8 text-foreground">
      <button type="button" onClick={onClose} aria-label="关闭"
        className="absolute right-4 top-4 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-500/10">
            <Database className="h-5 w-5 text-cyan-300" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">建立你的知识库</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Penguin 会把代码仓库解析成可搜索的知识图谱。</p>
          </div>
        </div>

        <div className="mt-8 space-y-3">
          <div className={cn(step, "border-cyan-500/25")}>
            <span className={num}>1</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">选择第一个仓库</div>
              {indexing ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="min-w-0 truncate font-mono">{indexing.dir.split("/").pop()}</span>
                    <span className="ml-2 shrink-0 font-bold text-cyan-300">
                      {indexing.total > 0 ? `${pct}% · ${indexing.done}/${indexing.total}` : "扫描中…"}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
                  </div>
                  {indexing.file && <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{indexing.file}</p>}
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => void pickAndIndex()}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-[#04121a] hover:bg-cyan-300">
                    <FolderOpen className="h-4 w-4" /> 选择仓库并索引
                  </button>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    也可以在终端运行 <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-cyan-200/80">penguin init /path/to/repo</code>,每个仓库一次。
                  </p>
                </>
              )}
              {obError && <p className="mt-2 text-xs leading-relaxed text-amber-300">{obError}</p>}
            </div>
          </div>
          <div className={step}>
            <span className={num}>2</span>
            <div>
              <div className="text-sm font-semibold">等待索引完成</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">解析符号、调用关系、API 端点和跨服务连接;大仓库需要几分钟。</p>
            </div>
          </div>
          <div className={step}>
            <span className={num}>3</span>
            <div>
              <div className="text-sm font-semibold">自动进入 Wiki</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">索引就绪后本页自动切换:符号搜索、跨服务地图、调用链、事故笔记。</p>
            </div>
          </div>
        </div>

        {/* AI integration: one click sets up the terminal command, the MCP
            server for Claude Desktop/Claude Code/Codex, and the global
            CLAUDE.md / AGENTS.md guidance blocks. */}
        <div className="mt-4 rounded-xl border border-border bg-background/50 p-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">AI 集成</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                penguin 终端命令 · Claude / Codex 的 MCP 接入 · 全局 CLAUDE.md / AGENTS.md 指引
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Claude Code 可选原生 hooks；Codex 使用 canonical MCP + AGENTS.md，不伪装成相同的事件 hook。
              </p>
            </div>
            <button type="button" disabled={aiBusy} onClick={() => void setupAi()}
              className="flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">
              {aiBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {aiResults ? "重新配置" : "一键配置 AI 集成"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hookSessionStart}
                onChange={(event) => setHookSessionStart(event.target.checked)}
              />
              SessionStart compact status
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hookPromptSubmit}
                onChange={(event) => setHookPromptSubmit(event.target.checked)}
              />
              UserPromptSubmit bounded context
            </label>
            <button type="button" disabled={hookBusy} onClick={() => void applyHooks()}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-50">
              {hookBusy && <Loader2 className="h-3 w-3 animate-spin" />}
              应用 Hook 设置
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">两项均关闭时移除 Penguin hooks；其他工具管理的 hooks 不受影响。</p>
          {hookResult && (
            <p className={cn("mt-2 text-xs", hookResult.state === "ok" ? "text-emerald-300/90" : hookResult.state === "warn" ? "text-amber-300/90" : "text-red-300/90")}>
              {hookResult.state === "ok" ? "✓" : hookResult.state === "warn" ? "⚠" : "✗"} {hookResult.text}
            </p>
          )}
          {cliReady === false && !aiResults && !aiBusy && (
            <p className="mt-2 text-xs text-amber-300/90">检测到终端里还没有 penguin 命令 — 点右侧一键配置。</p>
          )}
          {aiResults && (
            <ul className="mt-3 space-y-1 text-xs">
              {aiResults.map((r, i) => (
                <li key={i} className={r.state === "ok" ? "text-emerald-300/90" : r.state === "warn" ? "text-amber-300/90" : "text-red-300/90"}>
                  {r.state === "ok" ? "✓" : r.state === "warn" ? "⚠" : "✗"} {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button type="button" onClick={onRefresh}
            className="rounded-lg border border-border px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-accent">
            立即检测
          </button>
          <span className="text-xs text-muted-foreground">每 5 秒自动检测一次</span>
        </div>
      </div>
    </div>
  );
}
