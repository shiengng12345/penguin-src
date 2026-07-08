import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Plus, X, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { newBodyField, moveField } from "@/lib/rest-body-fields";
import type { RestBodyField, RestBodyValueType } from "./rest-types";

// Typed key→value body editor: one row per JSON field (`variableName | type |
// value`). The type dropdown covers everything JSON can hold; object/array take
// a JSON snippet in the value. Rows serialize to a JSON body on send
// (see fieldsToJson). Rows drag-to-reorder — which reorders the JSON keys too.
//
// Reordering uses POINTER events, not HTML5 drag-and-drop: WKWebView (Tauri's
// macOS webview) needs dataTransfer.setData to even start a native drag and its
// OS file-drop handler can swallow the events — pointer tracking sidesteps all
// of that and works everywhere.
const TYPE_OPTIONS: { value: RestBodyValueType; label: string }[] = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "null", label: "null" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
];

function valuePlaceholder(type: RestBodyValueType): string {
  switch (type) {
    case "number": return "0";
    case "boolean": return "true / false";
    case "null": return "(null)";
    case "object": return '{"k": "v"}';
    case "array": return "[1, 2, 3]";
    default: return "value";
  }
}

export function RestKeyValueBody({
  fields,
  onChange,
}: {
  fields: RestBodyField[];
  onChange: (fields: RestBodyField[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const update = (i: number, patch: Partial<RestBodyField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const add = () => onChange([...fields, newBodyField()]);
  const move = (from: number, to: number) => onChange(moveField(fields, from, to));

  // The row index whose vertical half the pointer sits in — the drop target.
  const targetIndexAt = (clientY: number): number => {
    const rows = containerRef.current?.querySelectorAll<HTMLElement>("[data-kv-row]");
    if (!rows || rows.length === 0) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length - 1;
  };

  const startDrag = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault(); // suppress text selection while dragging
    fromRef.current = i;
    setDragFrom(i);
    setDragOver(i);
    const onMove = (ev: PointerEvent) => setDragOver(targetIndexAt(ev.clientY));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const from = fromRef.current;
      const to = targetIndexAt(ev.clientY);
      fromRef.current = null;
      setDragFrom(null);
      setDragOver(null);
      if (from !== null) move(from, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex flex-col">
      {fields.length > 0 && (
        <div ref={containerRef} className="divide-y divide-border">
          {fields.map((f, i) => (
            <div
              key={f.id}
              data-kv-row
              className={cn(
                "group flex items-center gap-1.5 px-3 py-1",
                dragFrom === i && "opacity-40",
                dragOver === i && dragFrom !== i && "border-t-2 border-primary",
              )}
            >
              <span
                onPointerDown={startDrag(i)}
                title="拖动排序"
                className="shrink-0 touch-none cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
              />
              <input
                value={f.key}
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder="variableName"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 font-mono text-xs focus:border-border focus:outline-none"
              />
              <Select
                value={f.type}
                onChange={(e) => update(i, { type: e.target.value as RestBodyValueType })}
                options={TYPE_OPTIONS}
                className="h-7 w-[86px] shrink-0 font-mono text-xs"
              />
              <input
                value={f.type === "null" ? "" : f.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={valuePlaceholder(f.type)}
                disabled={f.type === "null"}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-7 min-w-0 flex-[2] rounded border border-transparent bg-transparent px-1.5 font-mono text-xs focus:border-border focus:outline-none disabled:opacity-40"
              />
              <button
                onClick={() => remove(i)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
                title="Remove field"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="px-3 py-1.5">
        <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={add}>
          <Plus className="mr-1 h-3 w-3" />
          Add field
        </Button>
      </div>
    </div>
  );
}
