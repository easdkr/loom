import type { ReactNode } from "react";

export interface CommandPaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  keywords?: string[];
  badge?: ReactNode;
  run: () => void | Promise<void>;
}

function searchableText(item: CommandPaletteItem): string {
  return [item.group, item.label, item.detail, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterCommandItems(
  items: CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return items;
  }
  const tokens = trimmed.split(/\s+/);
  return items.filter((item) => {
    const text = searchableText(item);
    return tokens.every((token) => text.includes(token));
  });
}
