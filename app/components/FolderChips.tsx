"use client";

import { Folder, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { sameFilter, type BrandGroup, type Filter } from "@/app/lib/folders";
import type { FolderRecord } from "@/app/lib/history-db";

/**
 * Horizontal filter chips: All / Favorites, then brands, then custom folders.
 * Used above the main gallery, and as the phone-layout stand-in for the
 * history panel's vertical rail (where a 200px sidebar doesn't fit).
 */
export default function FolderChips({
  filter,
  onChange,
  brands,
  folders,
  counts,
  total,
  favCount,
  className,
}: {
  filter: Filter;
  onChange: (next: Filter) => void;
  brands: BrandGroup[];
  folders: FolderRecord[];
  /** Folder id → logo count. */
  counts: Map<string, number>;
  total: number;
  favCount: number;
  className?: string;
}) {
  const chip = (
    key: string,
    value: Filter,
    label: string,
    count: number,
    icon?: React.ReactNode,
  ) => {
    const active = sameFilter(filter, value);
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(value)}
        aria-pressed={active}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "border-transparent bg-foreground text-background"
            : "border-border text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <span className="max-w-[9rem] truncate">{label}</span>
        <span className={cn("tabular-nums", !active && "opacity-60")}>
          {count}
        </span>
      </button>
    );
  };

  const divider = (key: string) => (
    <span key={key} aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
  );

  return (
    <div
      role="group"
      aria-label="Filter logos"
      className={cn(
        // Scrolls rather than wraps: a wrapping row changes height as you type
        // company names, shoving the grid up and down the page.
        "flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {chip("all", { kind: "all" }, "All", total)}
      {favCount > 0 &&
        chip(
          "fav",
          { kind: "favorites" },
          "Favorites",
          favCount,
          <Star
            className={cn(
              "size-3",
              filter.kind === "favorites" ? "fill-current" : "text-amber-500",
            )}
          />,
        )}
      {brands.length > 1 && divider("d1")}
      {brands.length > 1 &&
        brands.map((b) =>
          chip(`b-${b.key}`, { kind: "brand", key: b.key }, b.label, b.count),
        )}
      {folders.length > 0 && divider("d2")}
      {folders.map((f) =>
        chip(
          `f-${f.id}`,
          { kind: "folder", id: f.id },
          f.name,
          counts.get(f.id) ?? 0,
          <Folder className="size-3" />,
        ),
      )}
    </div>
  );
}
