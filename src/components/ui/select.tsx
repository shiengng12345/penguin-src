import * as React from "react";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
  color?: string;
}

interface SelectProps {
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

function ColorDot({ color, size = 8 }: { color?: string; size?: number }) {
  if (!color) return null;
  return (
    <span
      className="shrink-0 rounded-full ring-1 ring-white/20"
      style={{ width: size, height: size, backgroundColor: color }}
    />
  );
}

const Select = React.forwardRef<HTMLDivElement, SelectProps>(
  ({ className, options, placeholder, value, onChange, disabled }, ref) => {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [highlightIdx, setHighlightIdx] = useState(-1);

    const selected = options.find((o) => o.value === value);

    useEffect(() => {
      if (!open) return;
      function onClickOutside(e: MouseEvent) {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
          setOpen(false);
        }
      }
      document.addEventListener("mousedown", onClickOutside);
      return () => document.removeEventListener("mousedown", onClickOutside);
    }, [open]);

    const prevOpenRef = useRef(false);
    useEffect(() => {
      if (open && !prevOpenRef.current) {
        const idx = options.findIndex((o) => o.value === value);
        setHighlightIdx(idx >= 0 ? idx : 0);
        setTimeout(() => {
          if (!listRef.current) return;
          const el = listRef.current.children[idx >= 0 ? idx +(placeholder ? 1 : 0) : 0] as HTMLElement | undefined;
          el?.scrollIntoView({ block: "nearest" });
        }, 0);
      }
      prevOpenRef.current = open;
    }, [open]);

    const pick = (val: string) => {
      onChange?.({ target: { value: val } });
      setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (open && highlightIdx >= 0) {
          pick(options[highlightIdx].value);
        } else {
          setOpen(true);
        }
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setHighlightIdx((prev) => {
            const next = Math.min(prev +1, options.length - 1);
            const offset = placeholder ? 1 : 0;
            const el = listRef.current?.children[next +offset] as HTMLElement | undefined;
            el?.scrollIntoView({ block: "nearest" });
            return next;
          });
        }
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (open) {
          setHighlightIdx((prev) => {
            const next = Math.max(prev - 1, 0);
            const offset = placeholder ? 1 : 0;
            const el = listRef.current?.children[next +offset] as HTMLElement | undefined;
            el?.scrollIntoView({ block: "nearest" });
            return next;
          });
        }
      }
    };

    return (
      <div ref={containerRef} className={cn("relative h-8", className)}>
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={onKeyDown}
          className={cn(
            "flex h-full w-full items-center justify-between rounded-md border border-input bg-transparent px-2.5 text-xs transition-colors",
            "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            open && "ring-1 ring-ring"
          )}
        >
          <span
            className={cn(
              "flex items-center gap-2 truncate",
              selected ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <ColorDot color={selected?.color} />
            {selected?.label ?? placeholder ?? "Select..."}
          </span>
          <ChevronDown
            className={cn(
              "ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </button>

        {open && (
          <div
            ref={listRef}
            role="listbox"
            className="absolute left-0 top-full z-[90] mt-1 max-h-52 w-full min-w-[10rem] overflow-y-auto rounded-lg border border-input bg-background p-1 text-foreground shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95"
          >
            {placeholder && (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => pick("")}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                  "text-muted-foreground hover:bg-primary hover:text-primary-foreground",
                  !value && "bg-primary text-primary-foreground"
                )}
              >
                <span className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate italic">{placeholder}</span>
              </button>
            )}
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isHighlighted = i === highlightIdx;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => pick(opt.value)}
                  onMouseEnter={() => setHighlightIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                    "hover:bg-primary hover:text-primary-foreground",
                    isHighlighted && "bg-primary text-primary-foreground",
                    isSelected && "bg-primary text-primary-foreground font-medium"
                  )}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      isSelected ? "opacity-100 text-primary-foreground" : "opacity-0"
                    )}
                  />
                  <ColorDot color={opt.color} size={10} />
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })}
            {options.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                No environments
              </p>
            )}
          </div>
        )}
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select };
export type { SelectProps, SelectOption };
