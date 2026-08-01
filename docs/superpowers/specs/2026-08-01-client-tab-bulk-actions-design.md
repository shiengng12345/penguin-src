# Client Tab Bar — Bulk Actions + Duplicate (Right-Click Menu)

- **Date:** 2026-08-01
- **Branch:** `feature/knowledge-core`
- **Status:** Design approved (verbal "can can" + duplicate added); pending written-spec review
- **Area:** `src/components/layout/TabBar.tsx`, `src/lib/store.ts`, `src/lib/store-types.ts`, new `src/components/ui/context-menu.tsx`

## 1. Purpose

The Client module tab bar (REST / gRPC / gRPC-Web / SDK) only supports closing one tab at a time via a hover-revealed ✕. With many open tabs this is tedious. Add a **right-click context menu** on each tab offering the standard bulk-close set plus **Duplicate Tab**.

## 2. Scope (confirmed)

- Trigger: **right-click a tab** → context menu. (No extra "+" overflow menu.)
- Menu items: **Duplicate**, **Close**, **Close Others**, **Close to the Right**, **Close All**.
- Confirm before an action that would close **≥ 3** tabs (threshold as a named constant).
- Keep the existing invariant: the app always has **≥ 1 tab** (closing everything leaves one fresh empty tab).

Out of scope: drag-reorder, pinned tabs, "close to the left", per-tab dirty tracking.

## 3. Store actions (`store.ts` + `store-types.ts`)

Mirror the existing `removeTab` / `resetPackageTabs` pattern; every action persists via `saveTabs(nextTabs, nextActiveId)`.

- **`closeAllTabs()`** — replace all tabs with a single fresh `createTab()`; it becomes active. (Same shape as the existing `resetPackageTabs`.)
- **`closeOtherTabs(id)`** — keep only the tab whose id matches; it becomes active. No-op if it is already the only tab.
- **`closeTabsToRight(id)`** — keep tabs from index 0 through the matched tab (inclusive); drop the rest. If the active tab was among those dropped, active becomes `id`.
- **`duplicateTab(id)`** — deep-clone the source tab and insert the copy **immediately to its right**; the copy becomes active.
  - New `id` via the same scheme as `createTab`: `` `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` ``.
  - Deep copy with `structuredClone(src)` (RequestTab is fully serializable — it is already persisted). Guarantees editing the copy never mutates the original's `metadata` / `selectedMethod` / body.
  - Copied verbatim: `protocolTab`, `targetUrl`, `pathOverride`, `restMethod`, `restBodyMode`, `requestBody`, `metadata` (headers), `selectedPackage/Service/Method`.
  - Reset on the copy: `origin: null` (a new working copy, not the saved/history item — no misleading "Saved"/"History" badge), `response: null`, `isLoading: false`.

Type additions to `AppState` (`store-types.ts`):
```ts
closeAllTabs: () => void;
closeOtherTabs: (id: string) => void;
closeTabsToRight: (id: string) => void;
duplicateTab: (id: string) => void;
```

## 4. Context-menu primitive (new)

Add `src/components/ui/context-menu.tsx` as a **hand-rolled** lightweight menu.

> Design correction from initial plan: the codebase uses **no Radix** — `dialog.tsx` / `popover.tsx` are hand-rolled. To follow the existing pattern (rather than introduce a lone Radix dependency), the context menu is hand-rolled too: cursor positioning via `position: fixed` (escapes the tab strip's `overflow-x-auto`), a full-screen backdrop for outside-click/second-right-click dismiss, Escape/scroll/resize close, and viewport clamping.

Exports: `useContextMenu<T>()` (open state + cursor origin + right-clicked target), `ContextMenu` (positioned surface), `ContextMenuItem` (with `disabled` / `destructive` / `icon`), `ContextMenuSeparator`.

## 5. `TabBar.tsx` wiring

Wrap each tab element in `<ContextMenu><ContextMenuTrigger asChild>…</ContextMenuTrigger><ContextMenuContent>…`. The existing left-click (select) and ✕ (close) behavior is unchanged.

Menu (labels bilingual, matching the existing `New Tab / 新标签` style):
```
Duplicate / 复制标签          → duplicateTab(id)
──────────
Close / 关闭                  → removeTab(id)
Close Others / 关闭其他       → closeOtherTabs(id)      disabled when tabs.length <= 1
Close to the Right / 关闭右侧 → closeTabsToRight(id)    disabled when tab is the last
──────────
Close All / 全部关闭          → maybeConfirmThenCloseAll()  disabled when tabs.length <= 1
```

Confirm helper in `TabBar` (uses `window.confirm`, consistent with `RestPage`/`WikiPage`):
```ts
const CONFIRM_CLOSE_THRESHOLD = 3;
function confirmBulkClose(count: number): boolean {
  return count < CONFIRM_CLOSE_THRESHOLD || window.confirm(`关闭 ${count} 个标签？`);
}
```
Applied to **Close All** (count = `tabs.length`), **Close Others** (count = `tabs.length - 1`), and **Close to the Right** (count = tabs strictly to the right of `id`). **Close** and **Duplicate** never confirm.

## 6. Persistence

All four actions call `saveTabs`, so bulk close / duplicate survive a webview reload or app restart exactly like `addTab` / `removeTab` do today.

## 7. Testing

Store-level unit tests (pure logic, matching existing store test style):
- `closeAllTabs` → exactly one fresh tab, it is active.
- `closeOtherTabs(id)` → only that tab remains and is active; no-op when already single.
- `closeTabsToRight(id)` → tabs after `id` dropped; active reassigned to `id` when it had been to the right.
- `duplicateTab(id)` → length +1, copy sits right after source, copy is active, copy has a new id, `origin/response/isLoading` reset, and mutating the copy's `metadata` does not affect the source (deep-clone check).

TabBar right-click interaction is left to manual verification (Radix + jsdom is low-value to unit test here).

## 8. Milestones

1. Store: add the 4 actions + `AppState` types + unit tests.
2. UI: add `@radix-ui/react-context-menu` + `context-menu.tsx` primitive.
3. TabBar: wire the right-click menu, disabled states, and confirm helper.

## 9. Risks

- **Radix context menu vs the horizontally-scrolling tab strip** — ensure the trigger wrapping doesn't break the existing `overflow-x-auto` layout or the ✕ button's `stopPropagation`.
- **`structuredClone` availability** — fine in the Tauri webview (modern WebKit/Chromium); no polyfill needed.
- **Confirm threshold nagging** — 3 is a starting value; it is a named constant, easy to tune.
