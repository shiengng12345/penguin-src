import { cn } from "@/lib/utils";

interface RadioGroupProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  children: React.ReactNode;
  className?: string;
}

export function RadioGroup<T extends string>({ children, className }: RadioGroupProps<T>) {
  return <div role="radiogroup" className={cn("flex flex-col gap-2", className)}>{children}</div>;
}

interface RadioGroupItemProps {
  selected: boolean;
  onSelect: () => void;
  label: string;
  disabled?: boolean;
}

export function RadioGroupItem({ selected, onSelect, label, disabled }: RadioGroupItemProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 text-left text-sm",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border",
          selected ? "border-emerald-500" : "border-neutral-500",
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-emerald-500" />}
      </span>
      <span>{label}</span>
    </button>
  );
}
