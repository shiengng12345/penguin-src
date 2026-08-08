import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { useAppStore } from "@/lib/store";
import { themedMascot } from "@/lib/mascot";

interface ThemedMascotImgProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** The default (penguin) asset path, e.g. "/mascot/penguin/send.png". */
  base: string;
}

// <img> that swaps to the active theme's mascot variant (currently just the
// Duck set) and falls back to the penguin original if the variant file is
// missing — so a partial art set degrades gracefully instead of breaking.
export function ThemedMascotImg({ base, ...rest }: ThemedMascotImgProps) {
  const theme = useAppStore((s) => s.theme);
  const resolved = themedMascot(base, theme);
  const [src, setSrc] = useState(resolved);
  useEffect(() => {
    setSrc(resolved);
  }, [resolved]);
  return (
    <img
      {...rest}
      src={src}
      onError={() => {
        if (src !== base) setSrc(base);
      }}
    />
  );
}
