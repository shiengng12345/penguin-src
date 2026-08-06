import { useRef, useEffect, memo } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, syntaxTree } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, type CompletionContext, type Completion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { isLightAppTheme } from "@/lib/theme";
import type { FieldInfo } from "@/lib/store";

const themeCompartment = new Compartment();

function buildTheme(isDark: boolean) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        color: "var(--color-foreground)",
        fontSize: "12px",
        fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      },
      ".cm-content": {
        caretColor: "var(--color-primary)",
        padding: "8px 0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--color-primary)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        background: isDark ? "rgba(100, 150, 255, 0.15)" : "rgba(60, 120, 220, 0.15)",
      },
      ".cm-activeLine": {
        backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--color-muted-foreground)",
        border: "none",
        paddingRight: "4px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        fontSize: "10px",
        minWidth: "2em",
        padding: "0 4px 0 8px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        padding: "0 2px",
      },
      ".cm-scroller": {
        overflow: "auto",
      },
      ".cm-matchingBracket": {
        backgroundColor: isDark ? "rgba(100, 200, 100, 0.2)" : "rgba(60, 160, 60, 0.2)",
        outline: "1px solid rgba(100, 200, 100, 0.4)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--color-popover)",
        color: "var(--color-popover-foreground)",
        border: "1px solid var(--color-border)",
        borderRadius: "6px",
      },
      ".cm-tooltip .cm-diagnostic": {
        padding: "4px 8px",
        fontSize: "11px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        backgroundColor: "var(--color-popover)",
        border: "1px solid var(--color-border)",
        borderRadius: "6px",
        overflow: "hidden",
      },
      ".cm-tooltip-autocomplete ul": {
        fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: "11px",
      },
      ".cm-tooltip-autocomplete ul li": {
        padding: "2px 8px",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--color-accent)",
        color: "var(--color-accent-foreground)",
      },
      ".cm-completionLabel": {
        color: "var(--color-foreground)",
      },
      ".cm-completionDetail": {
        color: "var(--color-muted-foreground)",
        fontStyle: "italic",
        marginLeft: "8px",
      },
      ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "wavy underline var(--color-destructive)",
        textDecorationSkipInk: "none",
      },
      ".cm-lintPoint-error::after": {
        borderBottomColor: "var(--color-destructive)",
      },
      ".cm-placeholder": {
        color: "var(--color-muted-foreground)",
        fontStyle: "italic",
      },
    },
    { dark: isDark }
  );
}

// Colors resolve through CSS variables so every theme (incl. light ones) can
// supply a readable palette; the var() fallbacks are the original dark values.
const syntaxColors = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--syntax-property, #7dd3fc)" },
  { tag: tags.string, color: "var(--syntax-string, #86efac)" },
  { tag: tags.number, color: "var(--syntax-number, #fda4af)" },
  { tag: tags.bool, color: "var(--syntax-bool, #c4b5fd)" },
  { tag: tags.null, color: "var(--syntax-null, #94a3b8)" },
  { tag: tags.punctuation, color: "var(--syntax-punct, #94a3b8)" },
]);

function typeToDefault(type: string, repeated: boolean): string {
  if (repeated) return "[]";
  switch (type) {
    case "string": return '""';
    case "int32": case "int64": case "uint32": case "uint64":
    case "sint32": case "sint64": case "float": case "double":
    case "fixed32": case "fixed64": case "sfixed32": case "sfixed64":
      return "0";
    case "bool": return "false";
    default: return "{}";
  }
}

function fieldsAtPath(fields: FieldInfo[], jsonPath: string[]): FieldInfo[] {
  let current = fields;
  for (const seg of jsonPath) {
    const found = current.find((f) => f.name === seg);
    if (!found?.fields) return [];
    current = found.fields;
  }
  return current;
}

function getJsonPath(state: EditorState, pos: number): string[] {
  const path: string[] = [];
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, -1);

  while (node.parent) {
    if (node.type.name === "Property") {
      const keyNode = node.getChild("PropertyName");
      if (keyNode) {
        const keyText = state.doc.sliceString(keyNode.from, keyNode.to).replace(/^"|"$/g, "");
        path.unshift(keyText);
      }
    }
    node = node.parent;
  }
  return path;
}

function buildJsonCompletions(fields: FieldInfo[]) {
  return (context: CompletionContext) => {
    if (!fields || fields.length === 0) return null;

    const { state, pos } = context;
    const doc = state.doc.toString();
    const tree = syntaxTree(state);
    const node = tree.resolveInner(pos, -1);

    const lineText = state.doc.lineAt(pos).text;
    const lineStart = state.doc.lineAt(pos).from;
    const beforeCursor = lineText.slice(0, pos - lineStart);

    const isInsidePropertyName =
      node.type.name === "PropertyName" ||
      node.type.name === "⚠" ||
      (node.type.name === "Object" && /,\s*$|{\s*$/.test(beforeCursor));

    if (isInsidePropertyName || /^\s*"?\w*$/.test(beforeCursor.replace(/.*[{,]\s*/, ""))) {
      const jsonPath = getJsonPath(state, pos);
      const parentPath = jsonPath.length > 0 && node.type.name === "PropertyName"
        ? jsonPath.slice(0, -1)
        : jsonPath;
      const available = fieldsAtPath(fields, parentPath);

      const existingKeys = new Set<string>();
      let searchNode = node;
      while (searchNode && searchNode.type.name !== "Object") searchNode = searchNode.parent!;
      if (searchNode) {
        let child = searchNode.firstChild;
        while (child) {
          if (child.type.name === "Property") {
            const kn = child.getChild("PropertyName");
            if (kn) existingKeys.add(doc.slice(kn.from, kn.to).replace(/^"|"$/g, ""));
          }
          child = child.nextSibling;
        }
      }

      const wordMatch = beforeCursor.match(/"?(\w*)$/);
      const from = wordMatch ? pos - wordMatch[0].length : pos;

      const completions: Completion[] = available
        .filter((f) => !existingKeys.has(f.name))
        .map((f) => {
          const val = f.enumValues
            ? `"${f.enumValues[0] || ""}"`
            : typeToDefault(f.type, f.repeated);
          const detail = f.repeated ? `${f.type}[]` : f.type;
          return {
            label: f.name,
            type: f.fields ? "class" : f.enumValues ? "enum" : "property",
            detail,
            boost: f.optional ? 0 : 1,
            apply: `"${f.name}": ${val}`,
          };
        });

      if (completions.length === 0) return null;
      return { from, options: completions, validFor: /^"?\w*$/ };
    }

    if (node.type.name === "String" || node.parent?.type.name === "Property") {
      const propNode = node.type.name === "Property" ? node : node.parent;
      if (!propNode) return null;
      const keyNode = propNode.getChild("PropertyName");
      if (!keyNode) return null;
      const key = doc.slice(keyNode.from, keyNode.to).replace(/^"|"$/g, "");

      const jsonPath = getJsonPath(state, pos);
      const parentPath = jsonPath.slice(0, -1);
      const available = fieldsAtPath(fields, parentPath);
      const field = available.find((f) => f.name === key);

      if (field?.enumValues && field.enumValues.length > 0) {
        const wordMatch = beforeCursor.match(/"?(\w*)$/);
        const from = wordMatch ? pos - wordMatch[0].length : pos;

        return {
          from,
          options: field.enumValues.map((v) => ({
            label: v,
            type: "enum" as const,
            apply: `"${v}"`,
          })),
          validFor: /^"?\w*$/,
        };
      }
    }

    return null;
  };
}

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  fields?: FieldInfo[];
  // Read-only mode for displaying a response body / preview. Same
  // syntax highlighting + theme as the editable form, just non-
  // editable. CodeMirror's EditorState.readOnly + EditorView.editable
  // disable input handlers but keep selection + copy working.
  readOnly?: boolean;
}

export const JsonEditor = memo(function JsonEditor({
  value,
  onChange,
  placeholder = '{"key": "value"}',
  fields,
  readOnly = false,
}: JsonEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    if (!containerRef.current) return;

    const isDark = !isLightAppTheme(document.documentElement.getAttribute("data-theme"));

    const state = EditorState.create({
      doc: value,
      extensions: [
        ...(readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : []),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        foldGutter(),
        highlightSelectionMatches(),
        history(),
        json(),
        autocompletion({
          override: [
            (ctx: CompletionContext) => buildJsonCompletions(fieldsRef.current || [])(ctx),
          ],
          activateOnTyping: true,
          defaultKeymap: true,
        }),
        lintGutter(),
        linter(jsonParseLinter()),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(syntaxColors),
        themeCompartment.of(buildTheme(isDark)),
        cmPlaceholder(placeholder),
        EditorView.domEventHandlers({
          keydown(e, view) {
            if ((e.metaKey || e.ctrlKey) && e.key === "f") {
              return true;
            }
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              const { state } = view;
              const cur = state.selection.main.head;
              const before = state.doc.sliceString(0, cur);
              const after = state.doc.sliceString(cur);

              const indent = (() => {
                const line = state.doc.lineAt(cur).text;
                const match = line.match(/^(\s*)/);
                let base = match ? match[1] : "";
                const trimBefore = before.trimEnd();
                const lastChar = trimBefore[trimBefore.length - 1];
                if (lastChar === "{" || lastChar === "[" || lastChar === ",") {
                  base += "  ";
                }
                return base;
              })();

              const firstAfter = after.trimStart()[0];
              const closingBracket = firstAfter === "}" || firstAfter === "]";
              const currentIndent = (() => {
                const line = state.doc.lineAt(cur).text;
                const m = line.match(/^(\s*)/);
                return m ? m[1] : "";
              })();

              const insert = closingBracket
                ? "\n" +indent +"\n" +currentIndent
                : "\n" +indent;

              const cursorPos = cur +1 +indent.length;

              view.dispatch({
                changes: { from: cur, to: cur, insert },
                selection: { anchor: cursorPos },
              });

              queueMicrotask(() => {
                try {
                  const doc = view.state.doc.toString();
                  const parsed = JSON.parse(doc);
                  const formatted = JSON.stringify(parsed, null, 2);
                  if (formatted !== doc) {
                    const newCur = Math.min(view.state.selection.main.head, formatted.length);
                    view.dispatch({
                      changes: { from: 0, to: view.state.doc.length, insert: formatted },
                      selection: { anchor: newCur },
                    });
                  }
                } catch {
                  // not valid JSON yet
                }
              });

              return true;
            }
          },
        }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap.filter((b) => b.key !== "Mod-f" && b.key !== "Mod-g" && b.key !== "Mod-d"),
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    const el = containerRef.current;
    const captureModEnter = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.stopPropagation();
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          bubbles: true,
        }));
      }
    };
    el.addEventListener("keydown", captureModEnter, true);

    return () => {
      el.removeEventListener("keydown", captureModEnter, true);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const observer = new MutationObserver(() => {
      const isDark = !isLightAppTheme(document.documentElement.getAttribute("data-theme"));
      view.dispatch({
        effects: themeCompartment.reconfigure(buildTheme(isDark)),
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="h-full w-full overflow-auto" />;
});
