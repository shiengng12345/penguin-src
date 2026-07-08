import { useState } from "react";
import { Plus, X, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { newBodyField } from "@/lib/rest-body-fields";
import type { RestBodyField, RestBodyValueType } from "./rest-types";

// Typed key→value body editor: one row per JSON field (`variableName | type |
// value`). The type dropdown covers everything JSON can hold; object/array take
// a JSON snippet in the value. Rows serialize to a JSON body on send
// (see fieldsToJson). Mirrors the Headers table's row layout.
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
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const update = (i: number, patch: Partial<RestBodyField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const add = () => onChange([...fields, newBodyField()]);
  // Reorder rows — the JSON body follows this order (fieldsToJson emits keys in
  // array order), so dragging here also reorders the JSON tab's keys.
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="flex flex-col">
      {fields.length > 0 && (
        <div className="divide-y divide-border">
          {fields.map((f, i) => (
            <div
              key={f.id}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) move(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={cn(
                "group flex items-center gap-1.5 px-3 py-1",
                dragIndex === i && "opacity-50",
                overIndex === i && dragIndex !== i && "border-t-2 border-primary",
              )}
            >
              <span
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                title="拖动排序"
                className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
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
