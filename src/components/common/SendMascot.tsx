import { useAppStore } from "@/lib/store";
import { ThemedMascotImg } from "@/components/common/ThemedMascotImg";

// The Send button shows the themed mascot for every mascot theme EXCEPT Rabbit
// — the pale bunny reads poorly on the colored button, so it's left out until
// we find a better treatment for it.
export function SendMascot({ className }: { className?: string }) {
  const theme = useAppStore((s) => s.theme);
  if (theme === "rabbit") return null;
  return (
    <ThemedMascotImg base="/mascot/penguin/send.png" alt="" draggable={false} className={className} />
  );
}
