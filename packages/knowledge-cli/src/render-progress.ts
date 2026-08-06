// Live indexing renderer: discoveries scroll into history (plain println),
// while a stage tree + metrics footer redraws in place at the bottom (ANSI
// erase-and-rewrite, the log-update pattern). Only rendered when stderr is a
// TTY (bin.ts gates the sink on isTTY); NO_COLOR / color:false strips ANSI
// colors but keeps the region control sequences (they ARE the UI, not style).
import type { IndexProgressEvent, IndexStageId, IndexReport } from "@penguin/knowledge-indexer";

// Only scan + parse get their own line; the five fast post-parse passes
// collapse into one "Finalize graph" line (5 dim pending rows are noise).
const STAGES: Array<{ id: IndexStageId; label: string }> = [
  { id: "scan", label: "Workspace scan" },
  { id: "parse", label: "Parse & extract" },
];

const FINALIZE_SUBS: Array<{ id: IndexStageId; running: string }> = [
  { id: "deletes", running: "pruning deleted files" },
  { id: "proto", running: "extracting proto endpoints" },
  { id: "link", running: "linking services" },
  { id: "packages", running: "package dependencies" },
  { id: "git", running: "reading git history" },
];

const ALL_STAGE_IDS: IndexStageId[] = ["scan", "parse", "deletes", "proto", "link", "packages", "git"];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type StageState = { state: "pending" | "running" | "done"; detail?: string; elapsedMs?: number };

export interface RenderState {
  label: string;
  mode: "incremental" | "rebuild";
  stages: Record<IndexStageId, StageState>;
  done: number;
  total: number;
  file: string;
  // Per-language file counts (raw lang keys from the indexer; "other" =
  // non-source). Rendered as one bar per language group during parse.
  langTotals: Record<string, number>;
  langDone: Record<string, number>;
  symbols: number;
  edges: number;
  endpoints: number;
  discoveries: number;
  startedAt: number;
  parseStartedAt: number | null;
  spinnerFrame: number;
}

export function initialRenderState(label: string, mode: "incremental" | "rebuild", now: number): RenderState {
  const stages = Object.fromEntries(ALL_STAGE_IDS.map((id) => [id, { state: "pending" }])) as Record<
    IndexStageId,
    StageState
  >;
  return {
    label, mode, stages, done: 0, total: 0, file: "", langTotals: {}, langDone: {},
    symbols: 0, edges: 0, endpoints: 0, discoveries: 0,
    startedAt: now, parseStartedAt: null, spinnerFrame: 0,
  };
}

// Fold one pipeline event into the state. Returns a discovery line to print
// into scrollback (already colored), or null when only the region changed.
export function applyEvent(state: RenderState, ev: IndexProgressEvent, color: boolean, now: number): string | null {
  switch (ev.phase) {
    case "scan":
      state.total = ev.total;
      if (ev.langs) state.langTotals = ev.langs;
      return null;
    case "index":
      state.done = ev.done;
      state.total = ev.total;
      state.file = ev.file;
      if (ev.lang) state.langDone[ev.lang] = (state.langDone[ev.lang] ?? 0) + 1;
      return null;
    case "stage": {
      const s = state.stages[ev.stage];
      if (!s) return null;
      if (ev.state === "start") {
        s.state = "running";
        if (ev.stage === "parse") state.parseStartedAt = now;
      } else {
        s.state = "done";
        s.detail = ev.detail;
        s.elapsedMs = ev.elapsedMs;
      }
      return null;
    }
    case "metric":
      state.symbols = ev.symbols;
      state.edges = ev.edges;
      state.endpoints = ev.endpoints;
      return null;
    case "discovery": {
      state.discoveries += 1;
      return formatDiscoveryLine(ev, color);
    }
  }
  return null; // future event kinds: ignore, don't crash old CLIs
}

const KIND_LABEL: Record<string, string> = { endpoint: "endpoint", service: "service", link: "link" };

export function formatDiscoveryLine(
  ev: Extract<IndexProgressEvent, { phase: "discovery" }>,
  color: boolean,
): string {
  const c = painter(color);
  const kind = (KIND_LABEL[ev.kind] ?? ev.kind).padEnd(8);
  const file = ev.file ? c("2", `  ${ev.file}`) : "";
  return `  ${c("33", "✦")} ${c("2", kind)} ${ev.title}${file}`;
}

export function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtElapsed(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

// `\x1b[<sgr>m…\x1b[0m` or passthrough. sgr like "36" | "1;36" | "2" | "32".
function painter(color: boolean): (sgr: string, s: string) => string {
  return color ? (sgr, s) => `\x1b[${sgr}m${s}\x1b[0m` : (_sgr, s) => s;
}

function bar(done: number, total: number, width: number, c: (sgr: string, s: string) => string, color = "36"): string {
  const frac = total > 0 ? Math.min(1, done / total) : 1;
  const filled = Math.round(frac * width);
  return c(color, "█".repeat(filled)) + c("2", "░".repeat(width - filled));
}

function truncPath(p: string, max: number): string {
  return p.length <= max ? p : "…" + p.slice(-(max - 1));
}

const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript",
  rust: "Rust", go: "Go", java: "Java", php: "PHP", python: "Python",
  json: "JSON", proto: "Proto",
  other: "Other",
};

function langLabel(lang: string): string {
  return LANG_LABEL[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

// Truecolor language palette (validated categorical set for dark terminals:
// distinct hues, CVD-separated, ≥3:1 on dark surfaces). Basic ANSI codes get
// remapped by terminal themes into near-identical pastels — 24-bit doesn't.
// PHP and Proto share violet: they never co-occur in practice, and the bar's
// language label is the primary identity anyway.
const TRUECOLOR = typeof process !== "undefined" && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const LANG_RGB: Record<string, [string, string]> = {
  // [truecolor SGR, 256-color fallback SGR]
  TypeScript: ["38;2;57;135;229", "38;5;68"],
  JavaScript: ["38;2;201;133;0", "38;5;172"],
  JSON: ["38;2;25;158;112", "38;5;36"],
  Rust: ["38;2;217;89;38", "38;5;166"],
  Go: ["38;2;0;131;0", "38;5;28"],
  Java: ["38;2;230;103;103", "38;5;167"],
  Python: ["38;2;213;81;129", "38;5;168"],
  PHP: ["38;2;144;133;233", "38;5;104"],
  Proto: ["38;2;144;133;233", "38;5;104"],
};
const LANG_FALLBACK: [string, string] = ["38;2;143;143;143", "38;5;245"]; // neutral gray: Other + unknown
function langColor(label: string): string {
  return (LANG_RGB[label] ?? LANG_FALLBACK)[TRUECOLOR ? 0 : 1];
}

// Group per-language counts by display label (ts+tsx merge), largest first.
// More than 5 groups: keep the top 4 and fold the tail into "Other".
export function langGroups(state: RenderState): Array<{ label: string; done: number; total: number }> {
  const byLabel = new Map<string, { label: string; done: number; total: number }>();
  for (const [lang, total] of Object.entries(state.langTotals)) {
    const label = langLabel(lang);
    const g = byLabel.get(label) ?? { label, done: 0, total: 0 };
    g.total += total;
    g.done += Math.min(state.langDone[lang] ?? 0, total);
    byLabel.set(label, g);
  }
  const all = [...byLabel.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  if (all.length <= 5) return all;
  const head = all.filter((g) => g.label !== "Other").slice(0, 4);
  const folded = { label: "Other", done: 0, total: 0 };
  for (const g of all) {
    if (head.includes(g)) continue;
    folded.done += g.done;
    folded.total += g.total;
  }
  return [...head, folded];
}

// The in-place region: header, one line per stage, metrics footer.
export function renderRegionLines(state: RenderState, width: number, color: boolean, now: number): string[] {
  const c = painter(color);
  const lines: string[] = [];
  const mode = state.mode === "rebuild" ? " · rebuild" : "";
  lines.push(`🐧 ${c("1", "Penguin Index")} ${c("2", `· ${state.label}${mode}`)}`);
  for (const { id, label } of STAGES) {
    const s = state.stages[id];
    const name = label.padEnd(18);
    if (s.state === "done") {
      const elapsed = s.elapsedMs != null ? c("2", fmtElapsed(s.elapsedMs).padStart(7)) : "";
      const detail = s.detail ? c("2", s.detail) : "";
      lines.push(`  ${c("32", "✔")} ${name} ${detail}${detail && elapsed ? "  " : ""}${elapsed}`);
    } else if (s.state === "running") {
      const spin = c("36", SPINNER[state.spinnerFrame % SPINNER.length]);
      if (id === "parse" && state.total > 0) {
        const pct = `${String(Math.round((state.done / state.total) * 100)).padStart(3)}%`;
        const eta = etaText(state, now);
        const tail = `${c("1;36", pct)} · ${state.done}/${state.total}${eta ? c("2", ` · ETA ${eta}`) : ""}`;
        const groups = langGroups(state);
        if (groups.length > 1) {
          // One bar per language: each fills to 100% on its own, so users see
          // stages of completion instead of a single slow crawl.
          lines.push(`  ${spin} ${name} ${tail}`);
          for (const g of groups) {
            const count = `${g.done}/${g.total}`;
            lines.push(`      ${c("2", g.label.padEnd(12))} [${bar(g.done, g.total, 14, c, langColor(g.label))}] ${count.padStart(9)}`);
          }
        } else {
          lines.push(`  ${spin} ${name} [${bar(state.done, state.total, 20, c)}] ${tail}`);
        }
        if (state.file) lines.push(`      ${c("2", `└─ ${truncPath(state.file, Math.max(20, width - 10))}`)}`);
      } else {
        lines.push(`  ${spin} ${name}`);
      }
    } else {
      lines.push(`  ${c("2", `○ ${label}`)}`);
    }
  }
  lines.push(...finalizeLine(state, c));
  lines.push(
    `  ${c("2", "Symbols")} ${fmtInt(state.symbols)}   ${c("2", "Edges")} ${fmtInt(state.edges)}   ${c("2", "Endpoints")} ${fmtInt(state.endpoints)}`,
  );
  return lines;
}

// The collapsed "Finalize graph" line: pending until any sub-stage starts,
// shows the running sub-step by name, and when ALL subs are done becomes one
// ✔ line with their summed elapsed + the interesting details joined.
function finalizeLine(state: RenderState, c: (sgr: string, s: string) => string): string[] {
  const name = "Finalize graph".padEnd(18);
  const subs = FINALIZE_SUBS.map((sub) => ({ ...sub, s: state.stages[sub.id] }));
  if (subs.every(({ s }) => s.state === "pending")) return [`  ${c("2", "○ Finalize graph")}`];
  if (subs.every(({ s }) => s.state === "done")) {
    const elapsed = subs.reduce((a, { s }) => a + (s.elapsedMs ?? 0), 0);
    const detail = subs.map(({ s }) => s.detail).filter(Boolean).join(" · ");
    return [
      `  ${c("32", "✔")} ${name} ${detail ? c("2", detail) : ""}${detail ? "  " : ""}${c("2", fmtElapsed(elapsed).padStart(7))}`,
    ];
  }
  const running = subs.find(({ s }) => s.state === "running");
  const spin = c("36", SPINNER[state.spinnerFrame % SPINNER.length]);
  return [`  ${spin} ${name} ${running ? c("2", running.running) : ""}`];
}

function etaText(state: RenderState, now: number): string | null {
  if (!state.parseStartedAt || state.done < 10 || state.total === 0) return null;
  const elapsed = now - state.parseStartedAt;
  if (elapsed < 500) return null;
  const remainMs = (elapsed / state.done) * (state.total - state.done);
  return fmtElapsed(remainMs);
}

// Completion card: a vertical stat block — one number per line, zero-count
// lines omitted (a "0 endpoints" line is noise, not information).
export function summaryLines(report: IndexReport, state: RenderState, elapsedMs: number, color: boolean): string[] {
  const c = painter(color);
  if (report.parsed === 0 && report.deleted === 0) {
    return [
      `  ${c("32", "✓")} Already fresh · ${fmtInt(report.scanned)} files checked in ${fmtElapsed(elapsedMs)}`,
    ];
  }
  const verb = state.mode === "rebuild" ? "Rebuild" : "Index";
  const stat = (n: number, label: string) => `    ${c("1", fmtInt(n))} ${label}`;
  const lines: string[] = [];
  lines.push(`  ${c("32", "✓")} ${verb} completed · ${c("1", report.branchName)}`);
  lines.push("");
  lines.push(stat(report.scanned, "files"));
  lines.push(stat(state.symbols, "symbols"));
  lines.push(stat(state.edges, "edges"));
  if (state.endpoints > 0) lines.push(stat(state.endpoints, "endpoints"));
  if (report.skipped > 0) lines.push(`    ${c("2", `${fmtInt(report.skipped)} unchanged`)}`);
  if (report.errors > 0) {
    lines.push(`    ${c("33", `${report.errors} parser error${report.errors === 1 ? "" : "s"}`)} ${c("2", "→ penguin doctor")}`);
  }
  lines.push("");
  lines.push(`    ${c("2", "Elapsed")} ${fmtElapsed(elapsedMs)}`);
  lines.push("");
  lines.push(`    ${c("2", "Try")}  penguin search <symbol> ${c("2", "·")} penguin architecture`);
  return lines;
}

// Stateful writer: prints discoveries above a redrawn tail region.
export function createIndexRenderer(opts: {
  write: (chunk: string) => void;
  label: string;
  mode: "incremental" | "rebuild";
  color?: boolean;
  width?: number;
  now?: () => number;
}): { handle: (ev: IndexProgressEvent) => void; finish: (report: IndexReport) => void } {
  const now = opts.now ?? Date.now;
  const color = opts.color ?? !process.env.NO_COLOR;
  const width = opts.width ?? 80;
  const state = initialRenderState(opts.label, opts.mode, now());
  let regionLines = 0;
  let lastDraw = 0;
  let finished = false;

  const erase = () => {
    if (regionLines > 0) opts.write(`\x1b[${regionLines}F\x1b[J`);
    regionLines = 0;
  };
  const draw = () => {
    const lines = renderRegionLines(state, width, color, now());
    opts.write(lines.join("\n") + "\n");
    regionLines = lines.length;
  };

  // Spinner keeps moving through long single files; unref so the process can
  // exit if indexing ends without finish() (defensive).
  const timer = setInterval(() => {
    if (finished) return;
    state.spinnerFrame += 1;
    erase();
    draw();
  }, 120);
  timer.unref?.();

  opts.write("\x1b[?25l"); // hide cursor while the region redraws

  return {
    handle(ev) {
      const discovery = applyEvent(state, ev, color, now());
      const t = now();
      // Throttle pure-progress redraws to ~12fps; always draw structure changes.
      const structural = ev.phase === "stage" || discovery != null;
      if (!structural && t - lastDraw < 80) return;
      lastDraw = t;
      erase();
      if (discovery) opts.write(discovery + "\n");
      draw();
    },
    finish(report) {
      finished = true;
      clearInterval(timer);
      erase();
      const lines = summaryLines(report, state, now() - state.startedAt, color);
      opts.write(lines.join("\n") + "\n");
      opts.write("\x1b[?25h"); // restore cursor
    },
  };
}
