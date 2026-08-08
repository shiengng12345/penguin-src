import { useAppStore } from "@/lib/store";

// The Send button shows the mascot ONLY on the default Penguin theme. Other
// themes keep their mascots in the sidebar / header but leave Send text-only,
// since a pale critter on a colored Send button reads poorly.
export function SendMascot({ className }: { className?: string }) {
  const theme = useAppStore((s) => s.theme);
  if (theme !== "penguin") return null;
  return <img src="/mascot/penguin/send.png" alt="" draggable={false} className={className} />;
}
