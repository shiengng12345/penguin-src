import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled, id }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-4 w-4 items-center justify-center rounded border transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-neutral-500 bg-transparent",
      )}
    >
      {checked && <Check className="h-3 w-3" />}
    </button>
  );
}
