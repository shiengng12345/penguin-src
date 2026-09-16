// Horizontally resizable column wrapper.
//
// Wraps any fixed-width sidebar / rail with a 3px draggable handle on
// its right edge. Width state is kept locally; if `persistKey` is set
// the width is also written to app_kv on drag-end so the user's
// chosen width survives reload + module switch.
//
// Used by VaultSidebar + VaultKindRail to support the user's request
// "我要这两个 column 都可以 horizontal drag". The pattern is generic
// enough to drop onto any sidebar in the app.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { cn } from "@/lib/utils";

interface ResizableColumnProps {
  children: ReactNode;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  // Optional app_kv key under which the chosen width persists. Without
  // it the column resets to defaultWidth every mount.
  persistKey?: string;
  // Optional class on the outer wrapper (e.g. border-r-defining
  // background / opacity). The width / shrink-0 / relative are owned
  // by this component.
  className?: string;
  // When true, the column does not sit at a hard pixel width: it grows to
  // fill whatever space its flex row has left over (`flex-grow`), using
  // `width` only as its minimum / drag-resize floor. Still fully
  // resizable — dragging raises or lowers that floor exactly as it would
  // for a fixed column. At most one column in a row should set this.
  grow?: boolean;
}

function clampWidth(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return Math.min(max, Math.max(min, (min + max) / 2));
  return Math.min(max, Math.max(min, value));
}

function loadPersistedWidth(
  persistKey: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!persistKey) return fallback;
  const raw = getPersistedValue(persistKey);
  if (raw === null || raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return fallback;
  return clampWidth(parsed, min, max);
}

export function ResizableColumn({
  children,
  defaultWidth,
  minWidth,
  maxWidth,
  persistKey,
  className,
  grow,
}: ResizableColumnProps) {
  // Lazy initial — read app_kv exactly once.
  const [width, setWidth] = useState<number>(() =>
    loadPersistedWidth(persistKey, defaultWidth, minWidth, maxWidth),
  );
  // Latest width tracked via ref so the mouse-up listener can persist
  // synchronously without racing the React state commit.
  const latestWidthRef = useRef<number>(width);
  // Anchor: where the column's left edge starts on the page when drag
  // begins. Captured at mousedown so we can compute width as
  // (mouseX − leftEdgeX) and avoid jitter from the handle's own width.
  const dragStartRef = useRef<{ leftEdgeX: number; startWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragStartRef.current = { leftEdgeX: rect.left, startWidth: width };

      const onMove = (ev: MouseEvent) => {
        const anchor = dragStartRef.current;
        if (!anchor) return;
        const next = clampWidth(
          ev.clientX - anchor.leftEdgeX,
          minWidth,
          maxWidth,
        );
        latestWidthRef.current = next;
        setWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dragStartRef.current = null;
        if (persistKey) {
          setPersistedValue(persistKey, String(latestWidthRef.current));
        }
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width, minWidth, maxWidth, persistKey],
  );

  // Clamp on every defaultWidth / min / max change (e.g. user resized
  // their viewport and persisted width is now out of bounds).
  useEffect(() => {
    setWidth((prev) => {
      const clamped = clampWidth(prev, minWidth, maxWidth);
      if (clamped !== prev) latestWidthRef.current = clamped;
      return clamped;
    });
  }, [minWidth, maxWidth]);

  return (
    <div
      ref={containerRef}
      data-grow={grow ? "true" : undefined}
      style={grow ? { minWidth: `${width}px`, flex: "1 1 auto" } : { width: `${width}px` }}
      className={cn("relative", grow ? "flex-1" : "shrink-0", className)}
    >
      {children}
      {/* Drag handle — 3px visible strip on the right edge, with a
          wider transparent hit zone (after pseudo) so the user
          doesn't have to pixel-hunt. Cursor switches to col-resize
          on hover; primary tint when active. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        onMouseDown={onMouseDown}
        className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 active:bg-primary/60 after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']"
      />
    </div>
  );
}
