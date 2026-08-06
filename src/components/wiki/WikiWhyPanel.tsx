import { FileText, Pencil, Plus, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { RelChip } from "@/components/wiki/WikiUIKit";
import { WikiNoteEditor } from "@/components/wiki/WikiNoteEditor";
import type { ContextPack, KnowledgeNoteType } from "@/lib/knowledge-client";

type StateSetter<T> = (value: T | ((prev: T) => T)) => void;

const NOTE_TYPES: KnowledgeNoteType[] = ["incident", "decision", "bug", "architecture", "requirement", "compliance"];

function CreateNoteForm({
  creating,
  creatingBusy,
  onSubmitCreate,
  onSetCreating,
}: {
  creating: { type: KnowledgeNoteType; title: string };
  creatingBusy: boolean;
  onSubmitCreate: () => void;
  onSetCreating: StateSetter<{ type: KnowledgeNoteType; title: string } | null>;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/70 p-3">
      <div className="mb-2 flex flex-wrap gap-1">
        {NOTE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onSetCreating((c) => (c ? { ...c, type: t } : c))}
            className={cn(
              "rounded-md px-2 py-1 text-[10px] font-semibold",
              creating.type === t ? "bg-cyan-500/25 text-cyan-100" : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        autoFocus
        value={creating.title}
        placeholder="Title"
        onChange={(e) => onSetCreating((c) => (c ? { ...c, title: e.target.value } : c))}
        onKeyDown={(e) => { if (e.key === "Enter") void onSubmitCreate(); if (e.key === "Escape") onSetCreating(null); }}
        className="w-full rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-cyan-500/40"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" onClick={() => onSetCreating(null)} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent">取消</button>
        <button
          type="button"
          onClick={() => void onSubmitCreate()}
          disabled={creatingBusy || !creating.title.trim()}
          className="rounded-md bg-cyan-400 px-2.5 py-1 text-[11px] font-bold text-[#04121a] hover:bg-cyan-300 disabled:opacity-50"
        >
          {creatingBusy ? "创建中" : "创建并编辑"}
        </button>
      </div>
    </div>
  );
}

export function WikiWhyPanel({
  f,
  pack,
  backlinks,
  editing,
  creating,
  creatingBusy,
  savingNote,
  onEditNote,
  onSaveNote,
  onCancelEdit,
  onSubmitCreate,
  onSetCreating,
  onSetEditing,
}: {
  f: NonNullable<ContextPack["focus"]> | null;
  pack: ContextPack | null;
  backlinks: { nodeId: string; title: string; nodeType: string }[];
  editing: { slug: string; body: string } | null;
  creating: { type: KnowledgeNoteType; title: string } | null;
  creatingBusy: boolean;
  savingNote: boolean;
  onEditNote: (slug: string) => void;
  onSaveNote: () => void;
  onCancelEdit: () => void;
  onSubmitCreate: () => void;
  onSetCreating: StateSetter<{ type: KnowledgeNoteType; title: string } | null>;
  onSetEditing: StateSetter<{ slug: string; body: string } | null>;
}) {
  if (editing) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Pencil className="h-4 w-4 text-emerald-300" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm">{editing.slug}.md</span>
          <button type="button" onClick={onCancelEdit} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">取消</button>
          <button type="button" onClick={() => void onSaveNote()} disabled={savingNote} className="flex items-center gap-1 rounded-md bg-cyan-400 px-2 py-1 text-xs font-bold text-[#04121a] hover:bg-cyan-300 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{savingNote ? "保存中" : "保存"}</button>
        </div>
        <div className="min-h-0 flex-1"><WikiNoteEditor body={editing.body} onChange={(v) => onSetEditing((e) => (e ? { ...e, body: v } : e))} /></div>
      </div>
    );
  }

  if (!f) {
    return (
      <div className="flex h-full flex-col p-5">
        <div className="mb-5">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
            <FileText className="h-5 w-5" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Why layer</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            这里保存调查结论、决策和事故记录。选中符号后会显示它关联的 notes、调用关系和新鲜度。
          </p>
        </div>

        {creating ? (
          <CreateNoteForm creating={creating} creatingBusy={creatingBusy} onSubmitCreate={onSubmitCreate} onSetCreating={onSetCreating} />
        ) : (
          <div className="space-y-2">
            {NOTE_TYPES.slice(0, 4).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onSetCreating({ type, title: "" })}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/30 px-3 py-2 text-left text-xs text-foreground hover:border-cyan-500/30 hover:bg-cyan-500/[0.06]"
              >
                <Plus className="h-3.5 w-3.5 text-cyan-300" />
                New {type}
              </button>
            ))}
          </div>
        )}

        <div className="mt-auto rounded-xl border border-border bg-background/35 p-3 text-xs leading-relaxed text-muted-foreground">
          Tip: 从搜索结果打开 symbol 后再记录，note 会更容易被下一次 MCP/AI 召回。
        </div>
      </div>
    );
  }

  const focusFresh = f.branches[0];
  return (
    <>
      <div className="border-b border-border bg-card p-4">
        <div className="mb-1 text-[11px] text-muted-foreground">Knowledge / <b className="text-cyan-300">{f.title}</b></div>
        {focusFresh && (
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-1 font-mono text-[11px] text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{focusFresh.branch} · {focusFresh.status}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <RelChip n={(pack?.callers.length ?? 0) + backlinks.length} label="被引用" />
          <RelChip n={pack?.calls.length ?? 0} label="调用" />
          <RelChip n={pack?.tests.length ?? 0} label="测试" />
          <RelChip n={pack?.routes.length ?? 0} label="入口" />
          {((pack?.remoteCalls.length ?? 0) + (pack?.invokedBy.length ?? 0)) > 0 && (
            <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-200">
              <b className="font-mono">{(pack?.remoteCalls.length ?? 0) + (pack?.invokedBy.length ?? 0)}</b> 跨服务
            </span>
          )}
        </div>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">关联笔记 · why</span>
          <button type="button" onClick={() => onSetCreating(creating ? null : { type: "incident", title: f.title })}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-cyan-300 hover:bg-cyan-500/10">
            <Plus className="h-3 w-3" />记录
          </button>
        </div>
        {creating && (
          <CreateNoteForm creating={creating} creatingBusy={creatingBusy} onSubmitCreate={onSubmitCreate} onSetCreating={onSetCreating} />
        )}
        {pack?.notes.length === 0 && !creating ? (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs leading-relaxed text-muted-foreground">
            还没有关联笔记。点 <span className="text-cyan-300">记录</span> 写下为什么、事故结论或决策，后续搜索和 AI 都能复用。
          </div>
        ) : pack?.notes.map((n) => (
          <button key={n.nodeId} type="button" onClick={() => onEditNote(n.title)} className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/30 px-3 py-2 text-left text-xs hover:border-cyan-500/30 hover:bg-cyan-500/[0.06]">
            <FileText className="h-3.5 w-3.5 text-emerald-300" /><span className="truncate">{n.title}</span>
          </button>
        ))}
      </div>
    </>
  );
}
