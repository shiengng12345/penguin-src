import type { RequestTab } from "./store-types";

// Pure tab-list transforms shared by the store's bulk actions. Kept free of
// zustand / tauri so they can be unit-tested directly. Each returns the next
// { tabs, activeTabId } pair; the store action wraps it with saveTabs().
export interface TabsState {
  tabs: RequestTab[];
  activeTabId: string | null;
}

// Keep only the tab with `id`; it becomes active. No-op if `id` is unknown.
export function closeOtherTabs(
  tabs: RequestTab[],
  id: string,
  activeTabId: string | null,
): TabsState {
  const keep = tabs.filter((t) => t.id === id);
  if (keep.length === 0) return { tabs, activeTabId };
  return { tabs: keep, activeTabId: id };
}

// Drop every tab strictly to the right of `id` (that tab and everything left of
// it stay). If the active tab fell off the right, the anchor `id` takes over.
export function closeTabsToRight(
  tabs: RequestTab[],
  id: string,
  activeTabId: string | null,
): TabsState {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return { tabs, activeTabId };
  const next = tabs.slice(0, idx + 1);
  const activeSurvives = activeTabId != null && next.some((t) => t.id === activeTabId);
  return { tabs: next, activeTabId: activeSurvives ? activeTabId : id };
}

// How many tabs sit strictly to the right of `id` — used to decide whether the
// bulk-close confirm threshold is crossed.
export function tabsToRightCount(tabs: RequestTab[], id: string): number {
  const idx = tabs.findIndex((t) => t.id === id);
  return idx === -1 ? 0 : tabs.length - idx - 1;
}

// Deep-clone the tab with `id`, insert the copy immediately to its right, and
// make the copy active. The copy is a fresh working tab: it keeps the request
// config (url, headers, body, selected method) but drops the saved/history
// origin badge and any prior response. No-op if `id` is unknown.
export function duplicateTab(
  tabs: RequestTab[],
  id: string,
  newId: string,
): TabsState {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return { tabs, activeTabId: id };
  const copy: RequestTab = {
    ...structuredClone(tabs[idx]),
    id: newId,
    origin: null,
    response: null,
    isLoading: false,
  };
  const next = [...tabs.slice(0, idx + 1), copy, ...tabs.slice(idx + 1)];
  return { tabs: next, activeTabId: newId };
}

// Reorder `fromId` relative to `toId`: dragged rightward it lands just after the
// target, leftward just before — matching how browser tab drags feel. Returns a
// new array (never mutates the input); no-op onto itself or an unknown id.
export function moveTab(
  tabs: RequestTab[],
  fromId: string,
  toId: string,
): RequestTab[] {
  const from = tabs.findIndex((t) => t.id === fromId);
  const to = tabs.findIndex((t) => t.id === toId);
  if (from === -1 || to === -1 || from === to) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  const target = next.findIndex((t) => t.id === toId);
  next.splice(from < to ? target + 1 : target, 0, moved);
  return next;
}
