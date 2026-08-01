import * as React from "react";
import { cn } from "@/lib/utils";

// Lightweight, hand-rolled right-click menu matching the codebase's other
// primitives (popover.tsx / dialog.tsx are hand-rolled too — the app pulls no
// Radix). Positioned at the cursor via `position: fixed` so it escapes the tab
// strip's `overflow-x-auto` clipping. Closes on outside click, Escape, scroll,
// or resize.

export interface ContextMenuOrigin {
  x: number;
  y: number;
}

// Manage open state + cursor position from a right-click. Returns props to
// spread and the current origin (null when closed).
export function useContextMenu<T>() {
  const [state, setState] = React.useState<{ origin: ContextMenuOrigin; target: T } | null>(null);
  const open = React.useCallback((event: React.MouseEvent, target: T) => {
    event.preventDefault();
    setState({ origin: { x: event.clientX, y: event.clientY }, target });
  }, []);
  const close = React.useCallback(() => setState(null), []);
  return { state, open, close };
}

export function ContextMenu({
  origin,
  onClose,
  children,
}: {
  origin: ContextMenuOrigin;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState(origin);

  // Clamp into the viewport once the menu has a measured size.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.min(origin.x, window.innerWidth - width - pad),
      y: Math.min(origin.y, window.innerHeight - height - pad),
    });
  }, [origin]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    // Full-screen backdrop catches an outside click (and a second right-click).
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        role="menu"
        style={{ top: pos.y, left: pos.x }}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "fixed min-w-[9rem] rounded-lg border border-border bg-popover p-1 shadow-xl",
          "animate-in fade-in-0 zoom-in-95",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ContextMenuItem({
  onSelect,
  disabled,
  destructive,
  icon,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors",
        "hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {icon && <span className="flex h-3.5 w-3.5 items-center justify-center">{icon}</span>}
      <span className="flex-1">{children}</span>
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
