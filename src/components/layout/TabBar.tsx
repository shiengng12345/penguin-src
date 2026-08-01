import { useLayoutEffect, useRef, useState } from "react";
import { useAppStore, useActiveTab, type ProtocolTab } from "@/lib/store";
import { tabsToRightCount } from "@/lib/tab-actions";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Globe, Server, Box, Plus, X, History, Bookmark, Copy, ArrowRightToLine } from "lucide-react";
import { cn } from "@/lib/utils";

// Ask before an action that would close this many tabs or more (a fresh empty
// tab always remains, so small closes don't nag). Tunable.
const CONFIRM_CLOSE_THRESHOLD = 3;

const PROTOCOL_BADGES: Record<
  ProtocolTab,
  { label: string; icon: typeof Globe; className: string }
> = {
  "grpc-web": {
    label: "gRPC-Web",
    icon: Globe,
    className: "bg-green-500/20 text-green-600 dark:text-green-400",
  },
  grpc: {
    label: "gRPC",
    icon: Server,
    className: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  },
  sdk: {
    label: "JS-SDK",
    icon: Box,
    className: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  },
  rest: {
    label: "REST",
    icon: Globe,
    className: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  },
};

interface TabBarProps {
  onCycleProtocol: () => void;
  onNewRequest: () => void;
}

export function TabBar({
  onCycleProtocol,
  onNewRequest,
}: TabBarProps) {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    removeTab,
    closeAllTabs,
    closeOtherTabs,
    closeTabsToRight,
    duplicateTab,
    moveTab,
  } = useAppStore();
  const activeTab = useActiveTab();
  const { state: menu, open: openMenu, close: closeMenu } = useContextMenu<string>();
  const [pendingClose, setPendingClose] = useState<{ count: number; action: () => void } | null>(null);
  // Drag-to-reorder: id of the tab being dragged and the tab currently hovered
  // as a drop target (drives the insertion indicator).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // FLIP reorder animation: keep a ref to each tab element and snapshot their
  // left edges right before a reorder, then slide each from its old position to
  // the new one after the DOM updates. No dependency, no layout thrash.
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevLefts = useRef<Map<string, number>>(new Map());
  const snapshotPositions = () => {
    const m = new Map<string, number>();
    tabRefs.current.forEach((el, id) => m.set(id, el.getBoundingClientRect().left));
    prevLefts.current = m;
  };
  useLayoutEffect(() => {
    const prev = prevLefts.current;
    if (prev.size === 0) return;
    prevLefts.current = new Map();
    tabRefs.current.forEach((el, id) => {
      const before = prev.get(id);
      if (before == null) return;
      const delta = before - el.getBoundingClientRect().left;
      if (!delta) return;
      el.style.transition = "none";
      el.style.transform = `translateX(${delta}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 200ms ease";
        el.style.transform = "";
        const done = () => {
          el.style.transition = "";
          el.removeEventListener("transitionend", done);
        };
        el.addEventListener("transitionend", done);
      });
    });
  }, [tabs]);

  const menuTabId = menu?.target ?? null;
  const menuIndex = menuTabId ? tabs.findIndex((t) => t.id === menuTabId) : -1;
  const isOnlyTab = tabs.length <= 1;
  const isLastTab = menuIndex >= 0 && menuIndex === tabs.length - 1;
  const rightCount = menuTabId ? tabsToRightCount(tabs, menuTabId) : 0;

  // Non-destructive menu action: close the menu, then run.
  const run = (fn: () => void) => {
    closeMenu();
    fn();
  };

  // Bulk close: below the threshold just do it; at/above it (or when `always`,
  // used by Close All), open an in-app confirm modal. window.confirm is
  // unreliable under Tauri's native webview (the WKWebView subview paints over
  // HTML), so the app uses its own Dialog.
  const guardBulk = (count: number, action: () => void, always = false) => {
    closeMenu();
    if (!always && count < CONFIRM_CLOSE_THRESHOLD) action();
    else setPendingClose({ count, action });
  };

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-card" data-tour="tab-bar">
      <div className="flex flex-1 items-center overflow-x-auto">
        {tabs.map((tab) => {
          const badge = PROTOCOL_BADGES[tab.protocolTab];
          const Icon = badge.icon;
          const isActive = tab.id === activeTabId;
          const label = tab.selectedMethod?.name ?? "New Tab / 新标签";

          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = "move";
                // WKWebView (macOS) only fires `drop` if drag data was set.
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                if (dragId && dragId !== tab.id) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverId(tab.id);
                }
              }}
              onDragLeave={() =>
                setDragOverId((cur) => (cur === tab.id ? null : cur))
              }
              onDrop={(e) => {
                e.preventDefault();
                const from = e.dataTransfer.getData("text/plain") || dragId;
                if (from && from !== tab.id) {
                  snapshotPositions();
                  moveTab(from, tab.id);
                }
                setDragId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDragOverId(null);
              }}
              onContextMenu={(e) => openMenu(e, tab.id)}
              onMouseDown={(e) => {
                // Middle-click (scroll-wheel button) closes the tab, like a
                // browser. preventDefault suppresses the middle-click autoscroll.
                if (e.button === 1) {
                  e.preventDefault();
                  removeTab(tab.id);
                }
              }}
              className={cn(
                "group relative flex shrink-0 cursor-grab items-center gap-1.5 border-r border-border px-3 py-1.5 transition-[opacity,background-color] duration-200 active:cursor-grabbing",
                isActive
                  ? "bg-background text-foreground"
                  : "bg-card text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/50",
                tab.id === dragId && "opacity-40",
                tab.id === dragOverId &&
                  "before:absolute before:inset-y-1 before:left-0 before:z-10 before:w-0.5 before:rounded-full before:bg-primary"
              )}
            >
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary" />
              )}
              <button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5"
              >
                <span
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    isActive ? badge.className : "opacity-50"
                  )}
                >
                  <Icon className="h-2.5 w-2.5" />
                  {badge.label}
                </span>
                <span className={cn("truncate text-xs", isActive && "font-medium")}>{label}</span>
                {tab.origin === "history" && (
                  <span className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0">
                    <History className="h-2 w-2" />
                    History
                  </span>
                )}
                {tab.origin === "saved" && (
                  <span className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium bg-sky-500/20 text-sky-600 dark:text-sky-400 shrink-0">
                    <Bookmark className="h-2 w-2" />
                    Saved
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:opacity-100 group-hover:opacity-70"
                title="Close tab / 关闭标签"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-0.5 border-l border-border pl-1 pr-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onCycleProtocol}
          disabled={!activeTab}
          title="Cycle protocol (⌘ +E) / 切换协议"
        >
          {activeTab && (
            <>
              {activeTab.protocolTab === "grpc-web" && (
                <Server className="h-3.5 w-3.5" />
              )}
              {activeTab.protocolTab === "grpc" && (
                <Box className="h-3.5 w-3.5" />
              )}
              {activeTab.protocolTab === "sdk" && (
                <Globe className="h-3.5 w-3.5" />
              )}
              {activeTab.protocolTab === "rest" && (
                <Server className="h-3.5 w-3.5" />
              )}
            </>
          )}
        </Button>
        <button
          type="button"
          onClick={onNewRequest}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-accent"
          title="Add tab / 添加标签"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {menu && menuIndex >= 0 && (
        <ContextMenu origin={menu.origin} onClose={closeMenu}>
          <ContextMenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            onSelect={() => run(() => duplicateTab(menu.target))}
          >
            复制标签 / Duplicate
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<X className="h-3.5 w-3.5" />}
            onSelect={() => run(() => removeTab(menu.target))}
          >
            关闭 / Close
          </ContextMenuItem>
          <ContextMenuItem
            disabled={isOnlyTab}
            onSelect={() => guardBulk(tabs.length - 1, () => closeOtherTabs(menu.target))}
          >
            关闭其他 / Close Others
          </ContextMenuItem>
          <ContextMenuItem
            icon={<ArrowRightToLine className="h-3.5 w-3.5" />}
            disabled={isLastTab}
            onSelect={() => guardBulk(rightCount, () => closeTabsToRight(menu.target))}
          >
            关闭右侧 / Close to the Right
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            destructive
            disabled={isOnlyTab}
            onSelect={() => guardBulk(tabs.length, () => closeAllTabs(), true)}
          >
            全部关闭 / Close All
          </ContextMenuItem>
        </ContextMenu>
      )}

      {pendingClose && (
        <Dialog open onOpenChange={() => setPendingClose(null)}>
          <DialogContent onClose={() => setPendingClose(null)} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>关闭 {pendingClose.count} 个标签？/ Close {pendingClose.count} tabs?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              此操作无法撤销（会保留一个空白标签）。/ This can't be undone (a blank tab stays).
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingClose(null)}>
                取消 / Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  pendingClose.action();
                  setPendingClose(null);
                }}
              >
                关闭 / Close
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
