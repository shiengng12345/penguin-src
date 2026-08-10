import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

// P1 config panel (rendered full-page inside the Extras page — not a modal).
// The Enable toggle is local-only for now; the Rust WallpaperManager + settings
// persistence land in P2. `onClose` (from the Extras page) navigates back.
export function WallpaperConfig(_: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl">🎨</span>
        <h2 className="text-base font-semibold text-foreground">Live Wallpaper</h2>
        <Badge variant="outline">macOS</Badge>
        <Badge variant="secondary">Experimental</Badge>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Enable live wallpaper</div>
          <div className="text-[11px] text-muted-foreground">
            Animated desktop background (web / video) behind your icons.
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable live wallpaper" />
      </div>

      <p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Preview shell — the background renderer isn't wired yet. This panel and the Extras page are
        the P1 slice; the macOS wallpaper window, source picker, and settings persistence land in P2.
      </p>
    </div>
  );
}
