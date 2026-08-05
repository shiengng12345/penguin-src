import { useEffect, useRef } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, type CompletionContext } from "@codemirror/autocomplete";
import { noteCompletionTrigger } from "@/lib/note-autocomplete";
import { knowledgeSearchV2, knowledgeTags, type KnowledgeSearchV2Response } from "@/lib/knowledge-client";

// Markdown note editor (Plan 8). CodeMirror with `[[` wikilink autocomplete:
// typing `[[query` searches the graph and completes to `[[Title]]`. The trigger
// detection is the pure, unit-tested noteCompletionTrigger; `#` triggers are
// detected too (tag source is a follow-up once a tags endpoint exists).
export function WikiNoteEditor({ body, onChange }: { body: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!ref.current) return;

    // Tags are fetched once and cached (small, changes rarely) for `#` completion.
    let tagCache: string[] | null = null;

    const completionSource = async (ctx: CompletionContext) => {
      const prefix = ctx.state.sliceDoc(0, ctx.pos);
      const trig = noteCompletionTrigger(prefix);
      if (!trig) return null;

      if (trig.kind === "wikilink") {
        const q = trig.query.trim();
        if (!q) return null;
        // knowledgeSearchV2 hits carry `kind` (nodeType for symbol/note lanes,
        // lane-specific for path/source/semantic ones) instead of the legacy
        // hit's `nodeType` field — the completion popup only ever showed
        // title + a type label, so `kind` is a direct drop-in there.
        let hits: KnowledgeSearchV2Response["hits"] = [];
        try {
          hits = (await knowledgeSearchV2(q)).hits;
        } catch {
          return null;
        }
        if (hits.length === 0) return null;
        return {
          from: trig.from,
          options: hits.slice(0, 20).map((h) => ({ label: h.title, detail: h.kind, apply: `${h.title}]]` })),
          validFor: /[^\]\n]*$/,
        };
      }

      // `#` tag completion — offer existing tags, filtered by the partial.
      if (tagCache === null) {
        try {
          tagCache = await knowledgeTags();
        } catch {
          tagCache = [];
        }
      }
      const q = trig.query.toLowerCase();
      const matches = tagCache.filter((t) => t.toLowerCase().includes(q)).slice(0, 20);
      if (matches.length === 0) return null;
      return {
        from: trig.from,
        options: matches.map((t) => ({ label: t, type: "keyword" as const })),
        validFor: /[A-Za-z0-9_/-]*$/,
      };
    };

    const state = EditorState.create({
      doc: body,
      extensions: [
        history(),
        closeBrackets(),
        autocompletion({ override: [completionSource], activateOnTyping: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        cmPlaceholder("写点什么… 用 [[ 链接到符号/笔记,用 # 加标签"),
        EditorView.theme(
          {
            "&": { fontSize: "13px", height: "100%", backgroundColor: "transparent", color: "#e2e8f0" },
            ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: "10px" },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor": { borderLeftColor: "#22d3ee" },
          },
          { dark: true },
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: ref.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Reload when switching notes.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== body) v.dispatch({ changes: { from: 0, to: cur.length, insert: body } });
  }, [body]);

  return <div ref={ref} className="h-full w-full overflow-auto rounded-md border border-slate-800 bg-slate-950/40" />;
}
