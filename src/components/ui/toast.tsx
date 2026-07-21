import { create } from "zustand";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

interface ToastItem { id: number; message: string; }
interface ToastState {
  toasts: ToastItem[];
  push: (message: string) => void;
  remove: (id: number) => void;
}

let nextId = 1;
const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2400);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Fire a toast from anywhere (components or event listeners). */
export function toast(message: string) {
  useToastStore.getState().push(message);
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  useEffect(() => () => {}, []);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            "pointer-events-auto rounded-md bg-neutral-800 px-3 py-2 text-sm text-neutral-100 shadow-lg",
            "border border-neutral-700",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
