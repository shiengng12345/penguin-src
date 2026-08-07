// Persistent left-rail module switcher (Sprint 8.3). Lets the user jump
// between API Client / Vault / Knowledge Base without going back to the
// Home picker every time. Mounted in App.tsx between Header and the page
// content so it's visible regardless of which module is active.
//
// Gating tiers (Sprint 8.5 — three-tier model):
//   "none"        — always visible (Client)
//   "token"       — needs Dev Mode + any valid token (Vault, Browser)
//   "super-admin" — needs Dev Mode + super-admin token (Home / REST / Docs / Database)
// Super-admin implies token, so super-admin users see everything.

import { cn } from "@/lib/utils";

export type MainModule = "client" | "rest" | "vault" | "docs" | "database" | "wiki";

export interface MainSidebarProps {
  active: MainModule;
  onSelect: (module: MainModule) => void;
  // Dev Mode enabled + dev token validated. Unlocks Vault.
  hasValidToken: boolean;
  // Dev Mode enabled + super-admin token validated. Unlocks Home / REST / Docs / Database.
  isSuperAdmin: boolean;
}

type GateTier = "none" | "token" | "super-admin";

interface RailItem {
  kind: MainModule;
  // Mascot tile in /public/nav — full-color illustration, so active state is
  // shown with a ring + saturation instead of a currentColor tint.
  img: string;
  label: string;
  longLabel: string;
  requires: GateTier;
}

const ITEMS: RailItem[] = [
  { kind: "client", img: "/nav/client.png", label: "Client", longLabel: "API Client / 客户端", requires: "none" },
  { kind: "vault", img: "/nav/vault.png", label: "Vault", longLabel: "Vault / 凭据库", requires: "token" },
  { kind: "rest", img: "/nav/rest.png", label: "REST", longLabel: "REST API / 接口客户端", requires: "none" },
  { kind: "docs", img: "/nav/docs.png", label: "Docs", longLabel: "Knowledge Base / 知识库 (Super Admin)", requires: "super-admin" },
  { kind: "database", img: "/nav/database.png", label: "Database", longLabel: "Database / 数据库 (Super Admin)", requires: "super-admin" },
  // Penguin Knowledge Wiki — notes + code graph. Super-admin (dev-token) tier.
  { kind: "wiki", img: "/nav/wiki.png", label: "Wiki", longLabel: "Knowledge Wiki / 知识图谱 (Super Admin)", requires: "super-admin" },
];

export function MainSidebar({ active, onSelect, hasValidToken, isSuperAdmin }: MainSidebarProps) {
  const visibleItems = ITEMS.filter((item) => {
    if (item.requires === "none") return true;
    if (item.requires === "token") return hasValidToken;
    if (item.requires === "super-admin") return isSuperAdmin;
    return false;
  });
  return (
    <aside
      className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-card/30 py-3"
      aria-label="Module navigation"
    >
      {visibleItems.map((item) => {
        const isActive = active === item.kind;
        return (
          <button
            key={item.kind}
            type="button"
            onClick={() => onSelect(item.kind)}
            title={item.longLabel}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex w-14 flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors",
              isActive
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <img
              src={item.img}
              alt=""
              draggable={false}
              className={cn(
                "h-8 w-8 rounded-[22%] transition-all",
                isActive
                  ? "ring-2 ring-primary shadow-sm"
                  : "opacity-75 saturate-[0.6] hover:opacity-100 hover:saturate-100",
              )}
            />
            <span className="text-[10px] font-medium leading-tight">{item.label}</span>
          </button>
        );
      })}
    </aside>
  );
}
