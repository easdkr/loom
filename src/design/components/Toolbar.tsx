import type { ReactNode } from "react";

export interface ToolbarItem<T extends string = string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

interface ToolbarProps<T extends string> {
  items: ToolbarItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

export function Toolbar<T extends string>({ items, value, onChange, className }: ToolbarProps<T>) {
  return (
    <div role="tablist" className={["ds-toolbar", className].filter(Boolean).join(" ")}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          disabled={item.disabled}
          data-active={item.id === value}
          className="ds-toolbar-item"
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
