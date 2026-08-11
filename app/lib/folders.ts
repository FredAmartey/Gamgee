import type { Generation } from "@/app/components/Gallery";
import type { FolderRecord } from "./history-db";

/**
 * Organising logos into folders.
 *
 * Two kinds of grouping, deliberately different in nature:
 *
 * - **Brands** are derived, never stored. Every logo already carries the
 *   company name it was generated under, so grouping on that costs no schema,
 *   no migration, and applies retroactively to logos saved long before folders
 *   existed. Generate under a name and its group appears on its own.
 * - **Folders** are explicit and user-made. A logo is filed in at most one, via
 *   `folderId` on its record: filing is a move, not a tag, so the counts always
 *   add up and "where is that logo?" has exactly one answer.
 *
 * The two coexist. A logo is always in its brand group and may also sit in one
 * custom folder.
 */

export type BrandGroup = {
  /** Normalized grouping key (also the `Filter.key`). */
  key: string;
  /** Display name, in the most recently used spelling. */
  label: string;
  count: number;
  lastAt: number;
};

export const UNTITLED_LABEL = "Untitled";

/**
 * Group key for a company name. Case and spacing are noise here: someone who
 * types "Acme", "acme" and "Acme  Co" over a week means one brand, and three
 * near-identical rows in the rail would read as a bug.
 */
export function brandKey(companyName: string): string {
  return companyName.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Distinct brands across these logos, most recently used first. */
export function brandGroups(gens: Generation[]): BrandGroup[] {
  const map = new Map<string, BrandGroup>();
  for (const gen of gens) {
    const key = brandKey(gen.companyName);
    const at = gen.createdAt ?? 0;
    const label = gen.companyName.trim() || UNTITLED_LABEL;
    const found = map.get(key);
    if (!found) {
      map.set(key, { key, label, count: 1, lastAt: at });
      continue;
    }
    found.count += 1;
    // Newest spelling wins, so a group created as "ACME" relabels itself once
    // you start typing "Acme".
    if (at > found.lastAt) {
      found.lastAt = at;
      found.label = label;
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** How many logos sit in each custom folder, keyed by folder id. */
export function folderCounts(gens: Generation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const gen of gens) {
    if (!gen.folderId) continue;
    counts.set(gen.folderId, (counts.get(gen.folderId) ?? 0) + 1);
  }
  return counts;
}

// ── Filtering ───────────────────────────────────────────────────────────────

export type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "brand"; key: string }
  | { kind: "folder"; id: string };

export const ALL_LOGOS: Filter = { kind: "all" };

export function sameFilter(a: Filter, b: Filter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "brand" && b.kind === "brand") return a.key === b.key;
  if (a.kind === "folder" && b.kind === "folder") return a.id === b.id;
  return true;
}

export function matchesFilter(gen: Generation, filter: Filter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "favorites":
      return !!gen.favorite;
    case "brand":
      return brandKey(gen.companyName) === filter.key;
    case "folder":
      return gen.folderId === filter.id;
  }
}

export function applyFilter(gens: Generation[], filter: Filter): Generation[] {
  if (filter.kind === "all") return gens;
  return gens.filter((gen) => matchesFilter(gen, filter));
}

/**
 * Human label for a filter. Resolves against the live folder and brand lists,
 * so a filter whose target has just been deleted degrades to "All logos"
 * rather than rendering a dangling id.
 */
export function filterLabel(
  filter: Filter,
  folders: FolderRecord[],
  brands: BrandGroup[],
): string {
  switch (filter.kind) {
    case "all":
      return "All logos";
    case "favorites":
      return "Favorites";
    case "brand":
      return brands.find((b) => b.key === filter.key)?.label ?? "All logos";
    case "folder":
      return folders.find((f) => f.id === filter.id)?.name ?? "All logos";
  }
}

/**
 * Whether a filter still points at something that exists. A folder can be
 * deleted, and a brand disappears when its last logo is deleted; either would
 * otherwise strand the user on a permanently empty grid.
 */
export function filterIsLive(
  filter: Filter,
  folders: FolderRecord[],
  brands: BrandGroup[],
): boolean {
  switch (filter.kind) {
    case "all":
    case "favorites":
      return true;
    case "brand":
      return brands.some((b) => b.key === filter.key);
    case "folder":
      return folders.some((f) => f.id === filter.id);
  }
}

/**
 * A folder name that's ready to save, or null. Trims, collapses whitespace, and
 * rejects both blanks and names already taken (case-insensitively), since two
 * folders called "Client work" are indistinguishable in the rail.
 */
export function normalizeFolderName(
  raw: string,
  existing: FolderRecord[],
  ignoreId?: string,
): string | null {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return null;
  const taken = existing.some(
    (f) => f.id !== ignoreId && f.name.toLowerCase() === name.toLowerCase(),
  );
  return taken ? null : name;
}
