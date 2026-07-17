import { createHash } from "node:crypto";

/** Obsidian Canvas JSON. The indexer treats the document as data only: it never
 * follows URLs, loads embeds, or evaluates node text. Unknown fields are kept
 * so newer Obsidian/plugin extensions survive an import/export cycle. */
export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group" | string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [key: string]: unknown;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function idOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function parseCanvas(source: string): CanvasDocument {
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new Error("CANVAS_INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CANVAS_INVALID_DOCUMENT");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error("CANVAS_INVALID_DOCUMENT");
  const nodes = raw.nodes.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`CANVAS_INVALID_NODE:${index}`);
    const node = clone(item as Record<string, unknown>);
    return {
      ...node,
      id: idOr(node.id, `node-${index + 1}`),
      type: idOr(node.type, "text"),
      x: numberOr(node.x, 0), y: numberOr(node.y, 0),
      width: numberOr(node.width, 200), height: numberOr(node.height, 100),
    } as CanvasNode;
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = raw.edges.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`CANVAS_INVALID_EDGE:${index}`);
    const edge = clone(item as Record<string, unknown>);
    const fromNode = idOr(edge.fromNode, "");
    const toNode = idOr(edge.toNode, "");
    if (!ids.has(fromNode) || !ids.has(toNode)) throw new Error(`CANVAS_EDGE_NODE_NOT_FOUND:${index}`);
    return { ...edge, id: idOr(edge.id, `edge-${index + 1}`), fromNode, toNode } as CanvasEdge;
  });
  return { ...clone(raw), nodes, edges } as CanvasDocument;
}

export function serializeCanvas(document: CanvasDocument): string {
  // Stable key ordering makes generated files reviewable while preserving all
  // unknown values inside each object.
  const ordered = {
    ...(Object.fromEntries(Object.entries(document).filter(([key]) => key !== "nodes" && key !== "edges").sort(([a], [b]) => a.localeCompare(b)))),
    nodes: document.nodes,
    edges: document.edges,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function canvasToSearchableMarkdown(document: CanvasDocument, fileName: string): string {
  const title = fileName.replace(/\.canvas$/i, "");
  const lines: string[] = [`---`, `id: canvas:${fileName}`, `title: ${title}`, `type: canvas`, `---`, ""];
  for (const node of document.nodes) {
    if (node.type === "file" && typeof node.file === "string") lines.push(`[[${node.file}]]`);
    else if (typeof node.text === "string") lines.push(node.text);
    else if (node.type === "link" && typeof node.url === "string") lines.push(node.url);
  }
  for (const edge of document.edges) {
    if (typeof edge.label === "string" && edge.label.length > 0) lines.push(edge.label);
  }
  return `${lines.join("\n")}\n`;
}

export interface CanvasGraphSelection {
  nodes: Array<Partial<CanvasNode> & { id: string; title?: string; filePath?: string; locator?: Record<string, unknown> }>;
  edges: Array<Partial<CanvasEdge> & { fromNode: string; toNode: string }>;
}

export function exportGraphSelectionToCanvas(selection: CanvasGraphSelection): CanvasDocument {
  const nodes = selection.nodes.map((item, index) => {
    const node: CanvasNode = {
      ...item,
      id: item.id,
      type: item.type ?? (item.filePath ? "file" : "text"),
      x: item.x ?? (index % 4) * 260,
      y: item.y ?? Math.floor(index / 4) * 180,
      width: item.width ?? 220,
      height: item.height ?? 120,
      ...(item.filePath ? { file: item.filePath } : {}),
      ...(item.title && !item.text ? { text: item.title } : {}),
      ...(item.locator ? { "penguin-locator": clone(item.locator) } : {}),
    };
    return node;
  });
  const edges = selection.edges.map((edge, index) => ({ ...edge, id: edge.id ?? `edge-${index + 1}` } as CanvasEdge));
  const digest = createHash("sha256").update(JSON.stringify({ nodes, edges })).digest("hex");
  return { "penguin-export": { version: 1, selectionHash: digest }, nodes, edges };
}
