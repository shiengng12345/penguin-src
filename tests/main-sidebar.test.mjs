// MainSidebar module switcher + Dev Mode gating (Sprint 8.3 + 8.4).
//
// Source-assertion: MainSidebar is a JSX component and depends on the
// React + lucide-react runtime, so we read its source as text and grep
// for the contract pieces. App-side wiring (useDeveloperMode → unlocked
// → redirect) lives in App.tsx and is asserted the same way.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function loadSource(relPath) {
  return readFile(new URL(relPath, import.meta.url), "utf8");
}

test("MainSidebar exports MainModule + MainSidebar component", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  assert.match(src, /export type MainModule\b/);
  assert.match(src, /export function MainSidebar\(/);
  assert.match(src, /export interface MainSidebarProps/);
});

test("MainSidebar declares the modules: client / vault / browser / rest / docs / database", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  // The union members are written into MainModule.
  assert.match(src, /"client"\s*\|\s*"rest"\s*\|\s*"vault"\s*\|\s*"docs"\s*\|\s*"browser"\s*\|\s*"database"/);
  // ITEMS array contains each kind.
  for (const kind of ["client", "vault", "browser", "rest", "docs", "database"]) {
    assert.match(src, new RegExp(`kind:\\s*"${kind}"`));
  }
});

test("MainSidebar requires `hasValidToken` + `isSuperAdmin` props (Sprint 8.5 three-tier)", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  assert.match(src, /hasValidToken:\s*boolean/);
  assert.match(src, /isSuperAdmin:\s*boolean/);
  // Destructured in the function signature.
  assert.match(
    src,
    /export function MainSidebar\({\s*active,\s*onSelect,\s*hasValidToken,\s*isSuperAdmin\s*}/,
  );
});

test("MainSidebar filter handles all three gating tiers", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  // Filter must branch on each tier value and return the right prop.
  assert.match(src, /requires\s*===\s*"none"[\s\S]*?return true/);
  assert.match(src, /requires\s*===\s*"token"[\s\S]*?return hasValidToken/);
  assert.match(src, /requires\s*===\s*"super-admin"[\s\S]*?return isSuperAdmin/);
});

test("MainSidebar items include English label + bilingual tooltip", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  // Short labels under icon.
  assert.match(src, /label:\s*"Client"/);
  assert.match(src, /label:\s*"Vault"/);
  assert.match(src, /label:\s*"REST"/);
  assert.match(src, /label:\s*"Docs"/);
  // Tooltip bilingual — every module gets a "<English> / <中文>" longLabel
  // so first-time Chinese-speaking users get a hint on hover. Locking
  // ALL FIVE so a sidebar refactor that drops one tooltip is caught.
  // Literal substring match (CJK + regex special chars don't mix well).
  for (const literal of [
    'longLabel: "API Client / 客户端"',
    'longLabel: "Vault / 凭据库"',
    'longLabel: "In-App Browser / 内嵌浏览器 (Super Admin)"',
    'longLabel: "REST API / 接口客户端"',
    'longLabel: "Knowledge Base / 知识库 (Super Admin)"',
    'longLabel: "Database / 数据库 (Super Admin)"',
  ]) {
    assert.ok(src.includes(literal), `MainSidebar should declare: ${literal}`);
  }
});

test("MainSidebar uses aria-current to mark active module", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  // Locks both the binding (isActive) AND the value ("page" vs undefined).
  // Catches accidental hard-coding of aria-current or wrong-condition bind.
  assert.match(src, /aria-current=\{isActive\s*\?\s*"page"\s*:\s*undefined\}/);
});

test("App.tsx computes per-module gates (Vault = token, Docs = super-admin)", async () => {
  const src = await loadSource("../src/App.tsx");
  assert.match(src, /useDeveloperMode/);
  assert.match(src, /canAccessVault\s*=\s*devModeEnabled\s*&&\s*hasValidToken/);
  assert.match(src, /canAccessDocs\s*=\s*devModeEnabled\s*&&\s*isSuperAdmin/);
});

test("MainSidebar — REST module open to all users (regression guard)", async () => {
  // v1.12.0 deliberately opened REST to every user (client-module-style
  // layout, no tier gate). Without this guard, a future refactor could
  // silently re-gate REST behind token/super-admin and hide it from the
  // normal users who now rely on it.
  //
  // Regex anchors with `[^}]*?` (not `[\s\S]`) so the match window can't
  // cross an item boundary `}` and false-match an adjacent item's tier.
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  assert.match(
    src,
    /kind:\s*"rest"[^}]*?requires:\s*"none"/,
    "REST must be open to all (requires: none)",
  );
  assert.doesNotMatch(
    src,
    /kind:\s*"rest"[^}]*?requires:\s*"(token|super-admin)"/,
    "REST must NOT be gated behind a tier (regression check)",
  );
});

test("App.tsx wires MainSidebar gate props from per-tier access flags", async () => {
  const src = await loadSource("../src/App.tsx");
  // Token tier = Vault only. Docs / Database / Browser stay under
  // super-admin; REST left the OR when it opened to all users (v1.12.0).
  assert.match(src, /hasValidToken=\{canAccessVault\}/);
  assert.match(src, /isSuperAdmin=\{canAccessDocs\s*\|\|\s*canAccessDatabase\s*\|\|\s*canAccessBrowser\}/);
});

test("App.tsx redirects out of Vault when dev token revoked (regression)", async () => {
  const src = await loadSource("../src/App.tsx");
  // Effect body — Vault closes when canAccessVault drops, regardless of Docs.
  assert.match(
    src,
    /if\s*\(vaultOpen\s*&&\s*!canAccessVault\)\s*setVaultOpen\(false\);/,
  );
});

test("App.tsx redirects out of Docs when super-admin revoked (regression)", async () => {
  const src = await loadSource("../src/App.tsx");
  // Docs closes when canAccessDocs drops, regardless of Vault — independent gate.
  assert.match(
    src,
    /if\s*\(docsOpen\s*&&\s*!canAccessDocs\)\s*setDocsOpen\(false\);/,
  );
});

test("Dev token holder (token=true, super=false) sees Client + REST + Vault only", async () => {
  const src = await loadSource("../src/components/layout/MainSidebar.tsx");
  const expected = {
    client: "none",
    vault: "token",
    browser: "super-admin",
    rest: "none",
    docs: "super-admin",
    database: "super-admin",
  };
  for (const [kind, tier] of Object.entries(expected)) {
    const re = new RegExp(`kind:\\s*"${kind}"[^}]*?requires:\\s*"${tier}"`);
    assert.match(src, re, `${kind} should require ${tier}`);
  }
});

test("Header.tsx does not render a Vault toggle button or import the Lock icon", async () => {
  const src = await loadSource("../src/components/layout/Header.tsx");
  // The old Vault button pattern: a <button> with `onClick={onToggleVault}` and "Vault" text.
  assert.doesNotMatch(src, /onClick=\{onToggleVault\}/);
  // The Lock icon import should be gone.
  assert.doesNotMatch(src, /import\s*{[^}]*\bLock\b[^}]*}\s*from\s*"lucide-react"/);
});
