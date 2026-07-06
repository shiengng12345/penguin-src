import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Auto-prepend `https://` when the user typed a URL without a protocol.
 * Preserves `{{VAR}}` templates and already-protocol'd URLs as-is.
 */
export function ensureProtocol(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (/^https?:\/\//i.test(trimmed)) return raw;
  if (trimmed.startsWith("{{")) return raw;
  return `https://${trimmed}`;
}
