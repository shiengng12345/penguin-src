// tests/knowledge-cli-render.test.mjs
// Live indexing renderer: pure state/formatting functions + the stateful
// region writer (discoveries println'd to scrollback, stage tree redrawn).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialRenderState,
  applyEvent,
  renderRegionLines,
  formatDiscoveryLine,
  summaryLines,
  createIndexRenderer,
  fmtInt,
} from "../packages/knowledge-cli/dist/render-progress.js";

const T0 = 1_000_000;

function drive(state, events, color = false) {
  const out = [];
  for (const ev of events) {
    const d = applyEvent(state, ev, color, T0 + 1000);
    if (d) out.push(d);
  }
  return out;
}

test("region shows header, stage states, parse bar with counts, metrics footer", () => {
  const state = initialRenderState("FPMS-NT", "incremental", T0);
  drive(state, [
    { phase: "stage", stage: "scan", state: "start" },
    { phase: "scan", done: 0, total: 596, file: "" },
    { phase: "stage", stage: "scan", state: "done", detail: "596 files", elapsedMs: 400 },
    { phase: "stage", stage: "parse", state: "start" },
    { phase: "index", done: 364, total: 596, file: "src/auth/login.service.ts" },
    { phase: "metric", symbols: 14182, edges: 48211, endpoints: 61 },
  ]);
  const lines = renderRegionLines(state, 80, false, T0 + 5000);
  const text = lines.join("\n");
  assert.match(text, /Penguin Index · FPMS-NT/);
  assert.match(text, /✔ Workspace scan\s+596 files/);
  assert.match(text, /Parse & extract.*61%.*364\/596/);
  assert.match(text, /└─ src\/auth\/login\.service\.ts/);
  assert.match(text, /○ Finalize graph/, "post-parse stages collapse into one pending line");
  assert.ok(!/Prune deleted|Proto endpoints|Link services|Package deps|Git history/.test(text),
    "individual finalize sub-stages never render as their own lines");
  assert.match(text, /Symbols 14,182\s+Edges 48,211\s+Endpoints 61/);
});

test("multi-language repo renders one bar per language, single-language keeps the inline bar", () => {
  const state = initialRenderState("FPMS", "incremental", T0);
  drive(state, [
    { phase: "stage", stage: "parse", state: "start" },
    { phase: "scan", done: 0, total: 6, file: "", langs: { ts: 3, tsx: 1, js: 1, other: 1 } },
    { phase: "index", done: 1, total: 6, file: "a.ts", lang: "ts" },
    { phase: "index", done: 2, total: 6, file: "b.tsx", lang: "tsx" },
    { phase: "index", done: 3, total: 6, file: "c.js", lang: "js" },
  ]);
  const text = renderRegionLines(state, 80, false, T0 + 5000).join("\n");
  // ts+tsx merge under one TypeScript bar; each language's count advances independently
  assert.match(text, /TypeScript\s+\[[█░]+\]\s+2\/4/, `TypeScript bar in: ${text}`);
  assert.match(text, /JavaScript\s+\[[█░]+\]\s+1\/1/);
  assert.match(text, /Other\s+\[[█░]+\]\s+0\/1/);
  assert.match(text, /Parse & extract\s+50% · 3\/6/, "stage line keeps overall count");

  const single = initialRenderState("r", "incremental", T0);
  drive(single, [
    { phase: "stage", stage: "parse", state: "start" },
    { phase: "scan", done: 0, total: 4, file: "", langs: { ts: 4 } },
    { phase: "index", done: 2, total: 4, file: "a.ts", lang: "ts" },
  ]);
  const stext = renderRegionLines(single, 80, false, T0 + 5000).join("\n");
  assert.ok(!/TypeScript/.test(stext), "single language keeps the plain inline bar");
  assert.match(stext, /Parse & extract\s+\[[█░]+\]\s+50% · 2\/4/);
});

test("colored multi-language progress uses semantic colors instead of one cyan bar", () => {
  const state = initialRenderState("polyglot", "rebuild", T0);
  drive(state, [
    { phase: "stage", stage: "parse", state: "start" },
    { phase: "scan", done: 0, total: 5, file: "", langs: { ts: 1, js: 1, rust: 1, java: 1, python: 1 } },
    { phase: "index", done: 1, total: 5, file: "a.ts", lang: "ts" },
  ]);
  const text = renderRegionLines(state, 100, true, T0 + 5000).join("\n");
  // Truecolor palette with 256-color fallback (validated categorical set).
  assert.match(text, /\x1b\[38;(2;57;135;229|5;68)m█/, "TypeScript bar is blue");
  assert.match(text, /\x1b\[38;(2;201;133;0|5;172)m/, "JavaScript bar is gold");
  assert.match(text, /\x1b\[38;(2;217;89;38|5;166)m/, "Rust bar is orange");
  assert.match(text, /\x1b\[38;(2;230;103;103|5;167)m/, "Java bar is red");
  assert.match(text, /\x1b\[38;(2;213;81;129|5;168)m/, "Python bar is magenta");
  assert.ok(new Set([...text.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1])).size >= 6);
});

test("finalize group: shows the running sub-step, then one done line with summed elapsed", () => {
  const state = initialRenderState("r", "incremental", T0);
  drive(state, [
    { phase: "stage", stage: "parse", state: "done", elapsedMs: 100 },
    { phase: "stage", stage: "deletes", state: "start" },
  ]);
  let text = renderRegionLines(state, 80, false, T0).join("\n");
  assert.match(text, /Finalize graph\s+pruning deleted files/, `running sub-step shown in: ${text}`);

  drive(state, [
    { phase: "stage", stage: "deletes", state: "done", detail: "2 removed", elapsedMs: 40 },
    { phase: "stage", stage: "proto", state: "start" },
    { phase: "stage", stage: "proto", state: "done", elapsedMs: 10 },
    { phase: "stage", stage: "link", state: "start" },
    { phase: "stage", stage: "link", state: "done", elapsedMs: 30 },
    { phase: "stage", stage: "packages", state: "start" },
    { phase: "stage", stage: "packages", state: "done", elapsedMs: 10 },
    { phase: "stage", stage: "git", state: "start" },
    { phase: "stage", stage: "git", state: "done", detail: "132 commits", elapsedMs: 10 },
  ]);
  text = renderRegionLines(state, 80, false, T0).join("\n");
  assert.match(text, /✔ Finalize graph\s+2 removed · 132 commits\s+0\.1s/, `done line in: ${text}`);
});

test("ETA appears once enough files are done", () => {
  const state = initialRenderState("r", "incremental", T0);
  drive(state, [
    { phase: "stage", stage: "parse", state: "start" },
    { phase: "index", done: 300, total: 600, file: "x.ts" },
  ]);
  // parse started at T0+1000 (applyEvent time); render 4s later → rate known
  const text = renderRegionLines(state, 80, false, T0 + 5000).join("\n");
  assert.match(text, /ETA 4\.0s/, `expected ETA in: ${text}`);
});

test("discovery lines carry kind + title; colorless output has no ANSI escapes", () => {
  const line = formatDiscoveryLine(
    { phase: "discovery", kind: "endpoint", title: "GET /auth/me", file: "src/login.ts" },
    false,
  );
  assert.match(line, /✦ endpoint\s+GET \/auth\/me\s+src\/login\.ts/);
  assert.ok(!line.includes("\x1b["), "no escapes when color=false");
  const colored = formatDiscoveryLine({ phase: "discovery", kind: "link", title: "5 calls linked" }, true);
  assert.ok(colored.includes("\x1b[33m"), "gold ✦ when colored");
});

test("summary is a vertical stat card; zero-count lines are omitted", () => {
  const state = initialRenderState("FPMS", "rebuild", T0);
  state.symbols = 18432; state.edges = 62341; state.endpoints = 183;
  const report = {
    repoId: "r", branchId: "b", branchName: "brazil-v2", commit: "c",
    scanned: 596, parsed: 590, skipped: 4, deleted: 0, errors: 2, renamed: 0, commits: 0, tags: 0,
  };
  const lines = summaryLines(report, state, 12_400, false);
  const text = lines.join("\n");
  assert.match(text, /✓ Rebuild completed · brazil-v2/);
  assert.match(text, /^    596 files$/m);
  assert.match(text, /^    18,432 symbols$/m);
  assert.match(text, /^    62,341 edges$/m);
  assert.match(text, /^    183 endpoints$/m);
  assert.match(text, /^    4 unchanged$/m);
  assert.match(text, /2 parser errors.*penguin doctor/);
  assert.match(text, /Elapsed 12\.4s/);
  assert.match(text, /Try {2}penguin search/);
  // stat block is visually separated (blank line after the header)
  assert.equal(lines[1], "");

  // zero endpoints / zero errors / zero unchanged → those lines disappear
  const state2 = initialRenderState("FPMS", "incremental", T0);
  state2.symbols = 10; state2.edges = 20; state2.endpoints = 0;
  const clean = summaryLines({ ...report, skipped: 0, errors: 0 }, state2, 1000, false).join("\n");
  assert.match(clean, /✓ Index completed · brazil-v2/);
  assert.ok(!/endpoints/.test(clean), "0 endpoints omitted");
  assert.ok(!/errors/.test(clean), "0 errors omitted");
  assert.ok(!/unchanged/.test(clean), "0 unchanged omitted");

  const fresh = summaryLines({ ...report, parsed: 0, deleted: 0, skipped: 596, errors: 0 }, state, 300, false).join("\n");
  assert.match(fresh, /Already fresh · 596 files checked in 0\.3s/);
  assert.ok(!/Try/.test(fresh), "no-op run stays one quiet line");
});

test("writer prints discoveries into scrollback and redraws the region beneath", () => {
  const chunks = [];
  let t = T0;
  const r = createIndexRenderer({
    write: (s) => chunks.push(s), label: "repo", mode: "incremental",
    color: false, width: 80, now: () => (t += 200),
  });
  r.handle({ phase: "stage", stage: "scan", state: "start" });
  r.handle({ phase: "stage", stage: "scan", state: "done", detail: "3 files", elapsedMs: 10 });
  r.handle({ phase: "stage", stage: "parse", state: "start" });
  r.handle({ phase: "discovery", kind: "endpoint", title: "GET /auth/me", file: "a.ts" });
  r.finish({
    repoId: "r", branchId: "b", branchName: "main", commit: null,
    scanned: 3, parsed: 3, skipped: 0, deleted: 0, errors: 0, renamed: 0, commits: 0, tags: 0,
  });
  const all = chunks.join("");
  assert.ok(all.includes("✦ endpoint GET /auth/me".replace("  ", " ")) || /✦ endpoint\s+GET \/auth\/me/.test(all));
  assert.ok(/\x1b\[\d+F\x1b\[J/.test(all), "erases previous region before redraw");
  const lastErase = all.lastIndexOf("\x1b[J");
  assert.match(all.slice(lastErase), /Index completed · main/, "summary replaces the region at finish");
  assert.ok(all.includes("\x1b[?25l") && all.includes("\x1b[?25h"), "cursor hidden then restored");
  const discoveryAt = all.search(/✦ endpoint/);
  const summaryAt = all.search(/Index completed · main/);
  assert.ok(discoveryAt !== -1 && discoveryAt < summaryAt, "discovery stays in scrollback above summary");
});

test("fmtInt groups thousands", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(999), "999");
  assert.equal(fmtInt(14182), "14,182");
  assert.equal(fmtInt(1234567), "1,234,567");
});
