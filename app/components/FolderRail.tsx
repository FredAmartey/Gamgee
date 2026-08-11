"use client";

import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  Images,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  normalizeFolderName,
  sameFilter,
  type BrandGroup,
  type Filter,
} from "@/app/lib/folders";
import type { FolderRecord } from "@/app/lib/history-db";

/** One selectable row: label on the left, count on the right. */
function RailRow({
  label,
  count,
  active,
  icon,
  onSelect,
  trailing,
}: {
  label: string;
  count: number;
  active: boolean;
  icon?: React.ReactNode;
  onSelect: () => void;
  /** Optional action rendered over the row's right edge (the folder kebab). */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="group/row relative flex items-center">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "bg-foreground font-medium text-background"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={cn(
            "shrink-0 text-[0.6875rem] tabular-nums",
            active ? "opacity-70" : "opacity-50",
            // The kebab sits over the count on hover, so fade the count out
            // rather than letting the two overlap.
            trailing && "group-hover/row:opacity-0",
          )}
        >
          {count}
        </span>
      </button>
      {trailing}
    </div>
  );
}

/**
 * Inline text field for creating / renaming a folder. Enter commits, Escape
 * cancels, and blur commits too, so clicking away saves what you typed instead
 * of silently discarding it.
 */
export function NameField({
  defaultValue = "",
  invalid,
  onCommit,
  onCancel,
}: {
  defaultValue?: string;
  invalid: boolean;
  onCommit: (raw: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      maxLength={40}
      placeholder="Folder name"
      aria-label="Folder name"
      aria-invalid={invalid}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      className={cn(
        "w-full rounded-lg border bg-background px-2.5 py-1.5 text-[0.8125rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        invalid ? "border-destructive" : "border-input",
      )}
    />
  );
}

/**
 * The history panel's sidebar. Two kinds of grouping, kept visually distinct:
 * automatic brand groups (derived from each logo's company name) above custom
 * folders (made and filled by hand).
 */
export default function FolderRail({
  filter,
  onChange,
  brands,
  folders,
  counts,
  total,
  favCount,
  creating,
  onCreatingChange,
  createError,
  onCommitCreate,
  onRenameFolder,
  onDeleteFolder,
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
  /** Create-mode is owned by the parent, so the phone layout can share it. */
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
  createError: boolean;
  onCommitCreate: (raw: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  className?: string;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInvalid, setRenameInvalid] = useState(false);

  function commitRename(id: string, raw: string) {
    const current = folders.find((f) => f.id === id);
    if (!raw.trim() || raw.trim() === current?.name) {
      setRenamingId(null);
      setRenameInvalid(false);
      return;
    }
    const name = normalizeFolderName(raw, folders, id);
    if (!name) {
      setRenameInvalid(true);
      return;
    }
    onRenameFolder(id, name);
    setRenamingId(null);
    setRenameInvalid(false);
  }

  const favActive = sameFilter(filter, { kind: "favorites" });

  return (
    <div className={cn("flex flex-col gap-5 overflow-y-auto", className)}>
      <div className="space-y-0.5">
        <RailRow
          label="All logos"
          count={total}
          active={sameFilter(filter, { kind: "all" })}
          icon={<Images className="size-3.5 shrink-0" />}
          onSelect={() => onChange({ kind: "all" })}
        />
        {favCount > 0 && (
          <RailRow
            label="Favorites"
            count={favCount}
            active={favActive}
            icon={
              <Star
                className={cn(
                  "size-3.5 shrink-0",
                  favActive ? "fill-current" : "fill-amber-400 text-amber-400",
                )}
              />
            }
            onSelect={() => onChange({ kind: "favorites" })}
          />
        )}
      </div>

      {/* Brands come from the company name each logo was generated under, so
          they appear and disappear on their own. Only worth a section once
          there's more than one; with a single brand it just restates "All". */}
      {brands.length > 1 && (
        <div>
          <span className="label-eyebrow mb-1.5 block px-2.5">Brands</span>
          <div className="space-y-0.5">
            {brands.map((b) => (
              <RailRow
                key={b.key}
                label={b.label}
                count={b.count}
                active={sameFilter(filter, { kind: "brand", key: b.key })}
                onSelect={() => onChange({ kind: "brand", key: b.key })}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between px-2.5">
          <span className="label-eyebrow">Folders</span>
          <button
            type="button"
            onClick={() => {
              setRenamingId(null);
              onCreatingChange(true);
            }}
            aria-label="New folder"
            className="-mr-1 rounded p-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </div>
        <div className="space-y-0.5">
          {folders.map((f) => {
            const active = sameFilter(filter, { kind: "folder", id: f.id });
            return renamingId === f.id ? (
              <NameField
                key={f.id}
                defaultValue={f.name}
                invalid={renameInvalid}
                onCommit={(raw) => commitRename(f.id, raw)}
                onCancel={() => {
                  setRenamingId(null);
                  setRenameInvalid(false);
                }}
              />
            ) : (
              <RailRow
                key={f.id}
                label={f.name}
                count={counts.get(f.id) ?? 0}
                active={active}
                icon={<Folder className="size-3.5 shrink-0" />}
                onSelect={() => onChange({ kind: "folder", id: f.id })}
                trailing={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Manage ${f.name}`}
                        className={cn(
                          "absolute right-1 flex size-6 items-center justify-center rounded-md opacity-0 outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 data-[state=open]:opacity-100",
                          // Touch has no hover: keep it permanently reachable.
                          "[@media(hover:none)]:opacity-100",
                          active
                            ? "text-background hover:bg-white/15"
                            : "text-muted-foreground hover:bg-border/70 hover:text-foreground",
                        )}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem
                        onSelect={() => {
                          onCreatingChange(false);
                          setRenameInvalid(false);
                          setRenamingId(f.id);
                        }}
                      >
                        <Pencil className="size-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onDeleteFolder(f.id)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                        Delete folder
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            );
          })}
          {creating && (
            <NameField
              invalid={createError}
              onCommit={onCommitCreate}
              onCancel={() => onCreatingChange(false)}
            />
          )}
          {(createError || renameInvalid) && (
            <p className="px-2.5 pt-1 text-[0.6875rem] text-destructive">
              That name is already taken.
            </p>
          )}
          {!creating && folders.length === 0 && (
            <p className="px-2.5 py-1 text-[0.75rem] leading-relaxed text-muted-foreground">
              Group logos your own way. The brands above are made for you.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
