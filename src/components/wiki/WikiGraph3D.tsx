import { useEffect, useRef, useState } from "react";
import { logger } from "@/lib/logger";
import type { KnowledgeGraphView } from "@/lib/knowledge-client";

// 3D force-directed "globe" view (WebGL via 3d-force-graph → three.js). Dynamic-
// imported so three.js stays out of the main bundle and a load failure degrades
// gracefully. Drag to orbit; it auto-rotates gently for the 地球仪 feel.

const NODE_COLOR: Record<string, string> = {
  note: "#34d399", file: "#f59e0b", endpoint: "#fb7185", entity: "#e879f9", symbol: "#7c8db5",
};
const EDGE_COLOR: Record<string, string> = {
  calls: "#60a5fa", references: "#a78bfa", imports: "#64748b", defines: "#f59e0b",
  tests: "#34d399", handles: "#fb7185", invokes: "#38bdf8", throws: "#f87171", uses: "#e879f9",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

// 3d-force-graph needs a concrete canvas fill color (no CSS var support), so
// the page background token is resolved at read time via getComputedStyle.
// Kept local rather than shared with WikiGraph's identical helper — same
// precedent as WikiStatusFooter/BranchPickerPopover's duplicated
// formatRelativeTime: three lines, not worth the coupling.
function resolveBg(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim();
  if (!value) return fallback;
  // Theme tokens are oklch() (index.css), which three.js Color.setStyle does
  // NOT parse (2D canvas does — that's why WikiGraph is unaffected). Normalize
  // any CSS color to #rrggbb by letting the 2D canvas do the conversion.
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return fallback;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return fallback;
  }
}

export function WikiGraph3D({ data, onNodeClick }: { data: KnowledgeGraphView; onNodeClick: (id: string, event?: MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gRef = useRef<G>(null);
  const dataRef = useRef(data);
  const clickRef = useRef(onNodeClick);
  const [initError, setInitError] = useState<string | null>(null);
  dataRef.current = data;
  clickRef.current = onNodeClick;

  const toGraph = (v: KnowledgeGraphView) => ({
    nodes: v.nodes.map((n) => ({ id: n.nodeId, name: n.title, type: n.nodeType, isFocus: n.nodeId === v.focus })),
    links: v.edges.map((e) => ({ source: e.src, target: e.dst, edgeType: e.edgeType })),
  });

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    void import("3d-force-graph")
      .then(({ default: ForceGraph3D }) => {
        const el = ref.current;
        if (disposed || !el) return;
        // Zero-height guard: if this mounts before the flex layout settles,
        // a 0px canvas renders nothing forever (the ResizeObserver only fires
        // on CHANGES). Fall back to the window so something is visible.
        const width = el.clientWidth || window.innerWidth;
        const height = el.clientHeight || Math.max(window.innerHeight - 160, 320);
        const g: G = new (ForceGraph3D as unknown as new (el: HTMLElement) => G)(el)
          .backgroundColor(resolveBg("#080b11"))
          .nodeRelSize(4)
          .nodeColor((n: G) => (n.isFocus ? "#22d3ee" : NODE_COLOR[n.type] ?? NODE_COLOR.symbol))
          .nodeVal((n: G) => (n.isFocus ? 6 : 2))
          .nodeOpacity(0.95)
          .nodeLabel((n: G) => `<div style="font:12px ui-monospace,monospace;color:#e6edf3;background:#0e131c;border:1px solid #26303f;border-radius:6px;padding:3px 7px">${n.name}</div>`)
          .linkColor((l: G) => EDGE_COLOR[l.edgeType as string] ?? "rgba(148,163,184,0.4)")
          .linkOpacity(0.5)
          .linkWidth(0.6)
          .linkDirectionalParticles(2)
          .linkDirectionalParticleWidth(1.4)
          .linkDirectionalParticleSpeed(0.006)
          .onNodeClick((n: G, event: MouseEvent) => clickRef.current(String(n.id), event))
          .width(width)
          .height(height);
        // gentle auto-orbit (地球仪); stops while the user drags.
        const controls = g.controls?.();
        if (controls) { controls.autoRotate = true; controls.autoRotateSpeed = 0.6; }
        gRef.current = g;
        g.graphData(toGraph(dataRef.current));
        ro = new ResizeObserver(() => { const c = ref.current; if (c) g.width(c.clientWidth).height(c.clientHeight); });
        ro.observe(el);
      })
      .catch((error: unknown) => {
        // NEVER a silent blank canvas: surface the real reason on screen and
        // in the error log — a swallowed init error here cost a debugging
        // session ("why is 3D empty?") once already.
        const message = error instanceof Error ? error.message : String(error);
        logger.error("WikiGraph3D", "3D graph init failed", { error: message });
        if (!disposed) setInitError(message);
      });
    return () => {
      disposed = true;
      ro?.disconnect();
      gRef.current?._destructor?.();
      gRef.current = null;
    };
  }, []);

  useEffect(() => { if (gRef.current) gRef.current.graphData(toGraph(data)); }, [data]);

  // Same non-CSS-var canvas fill as WikiGraph — re-read + repaint on theme
  // switch (data-theme attribute flip, see store.ts setTheme).
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const g = gRef.current;
      if (!g) return;
      g.backgroundColor(resolveBg("#080b11"));
      const el = ref.current;
      if (el) g.width(el.clientWidth).height(el.clientHeight);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  if (initError) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        3D 渲染不可用：{initError} — 请切换到「整洁 / 力导向」视图，或反馈此错误信息。
      </div>
    );
  }
  return <div ref={ref} className="h-full w-full" />;
}
