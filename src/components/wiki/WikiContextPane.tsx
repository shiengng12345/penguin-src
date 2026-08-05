import { AlertTriangle, Loader2, Search, Sparkles } from "lucide-react";
import { Center, Dot } from "@/components/wiki/WikiUIKit";
import { ScopeBadge } from "@/components/wiki/ScopeBadge";
import type { ContextPack } from "@/lib/knowledge-client";

// NestJS built-in exceptions → the HTTP status they produce, so "会抛出" reads as
// the possible error responses of an endpoint.
const EXC_STATUS: Record<string, string> = {
  BadRequestException: "400", UnauthorizedException: "401", ForbiddenException: "403",
  NotFoundException: "404", MethodNotAllowedException: "405", NotAcceptableException: "406",
  RequestTimeoutException: "408", ConflictException: "409", GoneException: "410",
  PayloadTooLargeException: "413", UnsupportedMediaTypeException: "415", UnprocessableEntityException: "422",
  InternalServerErrorException: "500", NotImplementedException: "501", BadGatewayException: "502",
  ServiceUnavailableException: "503", GatewayTimeoutException: "504", RpcException: "gRPC",
};
const withStatus = (exc: string) => (EXC_STATUS[exc] ? `${EXC_STATUS[exc]} · ${exc}` : exc);

const briefCard = (label: string, items: { nodeId: string; title: string; nodeType: string }[], onSelectSymbol: (id: string) => void) =>
  items.length === 0 ? null : (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
        {label}<span className="ml-auto rounded-full bg-slate-800 px-1.5 font-mono text-[10px] text-slate-500">{items.length}</span>
      </div>
      <div className="p-2">
        {items.slice(0, 14).map((n) => (
          <button key={n.nodeId} type="button" onClick={() => onSelectSymbol(n.nodeId)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-xs text-slate-200 hover:bg-white/5">
            <Dot t={n.nodeType} /><span className="min-w-0 flex-1 truncate">{n.title}</span>
          </button>
        ))}
      </div>
    </div>
  );

// Cross-service (gRPC) links get a cyan-accented card so a service boundary
// crossing reads differently from an in-repo call.
const xServiceCard = (label: string, items: { nodeId: string; title: string; nodeType: string }[], onSelectSymbol: (id: string) => void) =>
  items.length === 0 ? null : (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.05]">
      <div className="flex items-center gap-2 border-b border-cyan-500/20 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-cyan-300">
        {label}<span className="ml-auto rounded-full bg-cyan-500/15 px-1.5 font-mono text-[10px] text-cyan-200">{items.length}</span>
      </div>
      <div className="p-2">
        {items.slice(0, 14).map((n) => (
          <button key={n.nodeId} type="button" onClick={() => onSelectSymbol(n.nodeId)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-xs text-cyan-100 hover:bg-cyan-500/10">
            <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400" /><span className="min-w-0 flex-1 truncate">{n.title}</span>
          </button>
        ))}
      </div>
    </div>
  );

const chipList = (label: string, items: string[], color: string) =>
  items.length === 0 ? null : (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex flex-wrap gap-1.5 p-2.5">
        {items.map((s) => <span key={s} className="rounded-md border border-slate-700 bg-slate-800/50 px-2 py-1 font-mono text-[11px]" style={{ color }}>{s}</span>)}
      </div>
    </div>
  );

export function WikiContextPane({
  packBusy,
  pack,
  onSelectSymbol,
}: {
  packBusy: boolean;
  pack: ContextPack | null;
  onSelectSymbol: (id: string) => void;
}) {
  const badge = <ScopeBadge locator={pack?.locator} alignment={pack?.alignment} warnings={pack?.warnings} />;
  const paddedBadge = <ScopeBadge locator={pack?.locator} alignment={pack?.alignment} warnings={pack?.warnings} className="px-5 pt-3" />;
  if (packBusy) return <div className="flex flex-1 flex-col">{paddedBadge}<Center><Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> 生成 Context Pack…</Center></div>;
  const f = pack?.focus;
  if (!f) {
    return (
      <div className="flex flex-1 flex-col">
        {paddedBadge}
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-6 text-center">
            <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
              <Search className="h-5 w-5" />
            </div>
            <div className="text-base font-semibold text-slate-100">Search or pick a symbol</div>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              Context Pack 会汇总源码、调用关系、入口、错误、env、测试和关联笔记。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-auto p-5">
      {badge}
      <div className="rounded-2xl border border-slate-800 bg-[#0d1420]/85 p-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
          <Sparkles className="h-3.5 w-3.5" />Context Pack
        </div>
        <div className="font-mono text-sm font-semibold text-slate-100">{f.title}</div>
        {f.filePath && <div className="mt-1 truncate font-mono text-xs text-slate-500">{f.filePath}</div>}
        {f.branches.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {f.branches.map((b) => (
              <span key={`${b.branch}:${b.status}`} className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1 font-mono text-[11px] text-slate-400">
                {b.branch} · {b.status}
              </span>
            ))}
          </div>
        )}
      </div>
      {pack!.signals.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
          {pack!.signals.map((s, i) => <div key={i} className="flex items-start gap-2 text-xs text-slate-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />{s}</div>)}
        </div>
      )}
      {f.source && (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1420]/85">
          <div className="border-b border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[10px] font-bold uppercase text-slate-400">源码 · {(f.filePath?.split(".").pop() ?? "ts")}</div>
          <pre className="max-h-80 overflow-auto bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-200"><code className="font-mono">{f.source}</code></pre>
        </div>
      )}
      {(pack!.remoteCalls.length > 0 || pack!.invokedBy.length > 0) && (
        <div className="grid grid-cols-2 gap-3">
          {xServiceCard("调用远程服务 · gRPC →", pack!.remoteCalls, onSelectSymbol)}
          {xServiceCard("被其他服务调用 · → gRPC", pack!.invokedBy, onSelectSymbol)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {briefCard("被调用 · 被引用", [...pack!.callers, ...pack!.referencedBy], onSelectSymbol)}
        {briefCard("调用 · 用到类型", [...pack!.calls, ...pack!.usesTypes], onSelectSymbol)}
        {briefCard("测试覆盖", pack!.tests, onSelectSymbol)}
        {briefCard("被这些文件 import", pack!.importers, onSelectSymbol)}
        {pack!.routes.length > 0 && chipList("HTTP / gRPC 入口", pack!.routes.map((r) => r.route), "#22d3ee")}
        {pack!.errors.length > 0 && chipList("可能错误响应", pack!.errors.map(withStatus), "#f87171")}
        {pack!.envs.length > 0 && chipList("用到 env", pack!.envs, "#e879f9")}
      </div>
    </div>
  );
}
