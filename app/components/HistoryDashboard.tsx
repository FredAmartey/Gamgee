"use client";

import { useState } from "react";
import {
  Check,
  Download,
  FileCode2,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  History,
  Loader2,
  Package,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Button } from "@/app/components/ui/button";
import { Tip } from "@/app/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { downloadBlob, slugify } from "@/app/lib/brand-kit";
import { logoToSvgBlob } from "@/app/lib/svg-export";
import {
  applyFilter,
  brandGroups,
  filterLabel,
  folderCounts,
  normalizeFolderName,
  type Filter,
} from "@/app/lib/folders";
import type { FolderRecord } from "@/app/lib/history-db";
import FolderRail, { NameField } from "./FolderRail";
import FolderChips from "./FolderChips";
import type { GenParams, Generation } from "./Gallery";

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dateLabel(ts: number | undefined): string {
  if (!ts) return "Earlier";
  const diffDays = Math.round(
    (startOfDay(Date.now()) - startOfDay(ts)) / 86400000,
  );
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

export default function HistoryDashboard({
  open,
  onClose,
  generations,
  savedKitIds,
  folders,
  filter,
  onFilterChange,
  onOpen,
  onCreateBrandKit,
  onLoad,
  onDelete,
  onClear,
  onToggleFavorite,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveToFolder,
}: {
  open: boolean;
  onClose: () => void;
  generations: Generation[];
  savedKitIds: Set<string>;
  folders: FolderRecord[];
  filter: Filter;
  onFilterChange: (next: Filter) => void;
  onOpen: (gen: Generation) => void;
  onCreateBrandKit: (gen: Generation) => void;
  onLoad: (params: GenParams) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onToggleFavorite: (gen: Generation) => void;
  /** Creates the folder and returns its id, so a pending logo can be filed. */
  onCreateFolder: (name: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveToFolder: (id: string, folderId: string | null) => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  // Folder creation. Owned here rather than in the rail because the phone
  // layout has no rail and needs the same field.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  // A logo waiting on "New folder…" from its own menu: filed the moment the
  // folder exists, so that flow is one gesture instead of create-then-move.
  const [pendingFileId, setPendingFileId] = useState<string | null>(null);

  const brands = brandGroups(generations);
  const counts = folderCounts(generations);
  const favCount = generations.filter((g) => g.favorite).length;
  const shown = applyFilter(generations, filter);
  const label = filterLabel(filter, folders, brands);

  function cancelCreate() {
    setCreating(false);
    setCreateError(false);
    setPendingFileId(null);
  }

  function commitCreate(raw: string) {
    if (!raw.trim()) return cancelCreate(); // typed nothing: close, no error
    const name = normalizeFolderName(raw, folders);
    if (!name) return setCreateError(true);
    const id = onCreateFolder(name);
    if (pendingFileId) onMoveToFolder(pendingFileId, id);
    cancelCreate();
  }

  function startNewFolderFor(logoId: string) {
    setPendingFileId(logoId);
    setCreateError(false);
    setCreating(true);
  }

  // Group consecutive same-day logos (the list is already newest-first).
  const groups: { label: string; items: Generation[] }[] = [];
  for (const gen of shown) {
    const day = dateLabel(gen.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === day) last.items.push(gen);
    else groups.push({ label: day, items: [gen] });
  }

  const empty = generations.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setConfirmClear(false);
          cancelCreate();
        }
      }}
    >
      <DialogContent className="flex h-[88svh] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-6 py-5 pr-12 text-left">
          <div>
            <DialogTitle className="text-lg">Your logo history</DialogTitle>
            <DialogDescription>
              {filter.kind === "all"
                ? `${generations.length} ${generations.length === 1 ? "logo" : "logos"} saved on this device.`
                : `${shown.length} of ${generations.length} shown in ${label}.`}
            </DialogDescription>
          </div>
          {!empty && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                onClick={() => {
                  if (confirmClear) {
                    onClear();
                    setConfirmClear(false);
                  } else {
                    setConfirmClear(true);
                  }
                }}
                onMouseLeave={() => setConfirmClear(false)}
                onBlur={() => setConfirmClear(false)}
                aria-label={
                  confirmClear
                    ? "Confirm clear all history"
                    : "Clear all history"
                }
                className={cn(
                  "rounded-lg text-xs",
                  confirmClear && "text-destructive",
                )}
              >
                <Trash2 className="size-3.5" />
                {confirmClear ? "Clear all?" : "Clear all"}
              </Button>
            </div>
          )}
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {!empty && (
            <FolderRail
              className="hidden w-56 shrink-0 border-r border-border px-3 py-5 sm:flex"
              filter={filter}
              onChange={onFilterChange}
              brands={brands}
              folders={folders}
              counts={counts}
              total={generations.length}
              favCount={favCount}
              creating={creating}
              onCreatingChange={(v) => (v ? setCreating(true) : cancelCreate())}
              createError={createError}
              onCommitCreate={commitCreate}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
            />
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* Phone layout: the rail's job, folded into a chip row. */}
            {!empty && (
              <div className="mb-5 space-y-2 sm:hidden">
                <div className="flex items-center gap-2">
                  <FolderChips
                    className="min-w-0 flex-1"
                    filter={filter}
                    onChange={onFilterChange}
                    brands={brands}
                    folders={folders}
                    counts={counts}
                    total={generations.length}
                    favCount={favCount}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPendingFileId(null);
                      setCreateError(false);
                      setCreating(true);
                    }}
                    aria-label="New folder"
                    className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FolderPlus className="size-3.5" />
                  </button>
                </div>
                {creating && (
                  <NameField
                    invalid={createError}
                    onCommit={commitCreate}
                    onCancel={cancelCreate}
                  />
                )}
                {createError && (
                  <p className="text-[0.6875rem] text-destructive">
                    That name is already taken.
                  </p>
                )}
              </div>
            )}

            {empty ? (
              <div className="flex h-full min-h-[20rem] flex-col items-center justify-center text-center">
                <History className="size-10 text-muted-foreground/40" />
                <p className="mt-4 text-sm font-medium text-foreground">
                  No logos yet
                </p>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  Generate a logo and it&apos;ll be saved here automatically,
                  only on this device.
                </p>
              </div>
            ) : shown.length === 0 ? (
              <div className="flex h-full min-h-[16rem] flex-col items-center justify-center text-center">
                <FolderOpen className="size-10 text-muted-foreground/40" />
                <p className="mt-4 text-sm font-medium text-foreground">
                  Nothing in {label} yet
                </p>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  Use a logo&apos;s folder button to file it here.
                </p>
                <button
                  type="button"
                  onClick={() => onFilterChange({ kind: "all" })}
                  className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Show all logos
                </button>
              </div>
            ) : (
              <div className="space-y-7">
                {groups.map((g, gi) => (
                  <div key={`${g.label}-${gi}`}>
                    <span className="label-eyebrow mb-3 block">{g.label}</span>
                    <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                      {g.items.map((gen) => (
                        <HistoryTile
                          key={gen.id}
                          gen={gen}
                          hasKit={savedKitIds.has(gen.id)}
                          folders={folders}
                          onOpen={onOpen}
                          onCreateBrandKit={onCreateBrandKit}
                          onLoad={onLoad}
                          onDelete={onDelete}
                          onToggleFavorite={onToggleFavorite}
                          onMoveToFolder={onMoveToFolder}
                          onNewFolderFor={startNewFolderFor}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryTile({
  gen,
  hasKit,
  folders,
  onOpen,
  onCreateBrandKit,
  onLoad,
  onDelete,
  onToggleFavorite,
  onMoveToFolder,
  onNewFolderFor,
}: {
  gen: Generation;
  hasKit: boolean;
  folders: FolderRecord[];
  onOpen: (gen: Generation) => void;
  onCreateBrandKit: (gen: Generation) => void;
  onLoad: (params: GenParams) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (gen: Generation) => void;
  onMoveToFolder: (id: string, folderId: string | null) => void;
  onNewFolderFor: (id: string) => void;
}) {
  const [svgBusy, setSvgBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const displayName = gen.name || gen.companyName || "Untitled";

  async function handleSvg() {
    if (svgBusy) return;
    setSvgBusy(true);
    try {
      const blob = await logoToSvgBlob(gen.image);
      downloadBlob(blob, `${slugify(displayName)}.svg`);
    } catch {
      toast({ variant: "destructive", title: "Couldn't vectorize this logo" });
    } finally {
      setSvgBusy(false);
    }
  }

  const pill =
    "flex size-7 items-center justify-center rounded-full bg-black/45 text-white/90 outline-none backdrop-blur-sm transition-colors hover:bg-black/65 focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:size-8";

  return (
    <div
      className="group relative aspect-square cursor-pointer overflow-hidden rounded-xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={() => onOpen(gen)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(gen);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${displayName}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={gen.image}
        alt={displayName}
        className="size-full object-contain"
      />
      {/* Favorite star: persistent when favorited, else on hover/focus */}
      <Tip
        label={gen.favorite ? "Remove from favorites" : "Add to favorites"}
        side="bottom"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(gen);
          }}
          aria-label={
            gen.favorite ? "Remove from favorites" : "Add to favorites"
          }
          aria-pressed={!!gen.favorite}
          className={cn(
            "absolute left-2 top-2 z-20 flex size-6 items-center justify-center rounded-full bg-black/45 outline-none backdrop-blur-sm transition-all focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:size-8",
            gen.favorite
              ? "text-amber-300 opacity-100"
              : "text-white/85 opacity-0 hover:text-white group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <Star className={cn("size-3", gen.favorite && "fill-amber-300")} />
        </button>
      </Tip>
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/65 via-black/0 to-black/10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <div className="pointer-events-auto flex items-start justify-between gap-1 p-2 pl-9">
          <span className="truncate rounded bg-black/45 px-1.5 py-0.5 text-[0.65rem] font-medium text-white backdrop-blur-sm">
            {displayName}
          </span>
          <Tip
            label={confirmDel ? "Click again to delete" : "Delete"}
            side="bottom"
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (confirmDel) onDelete(gen.id);
                else setConfirmDel(true);
              }}
              onMouseLeave={() => setConfirmDel(false)}
              onBlur={() => setConfirmDel(false)}
              aria-label={confirmDel ? "Confirm delete" : "Delete"}
              className={cn(
                "flex h-6 shrink-0 items-center justify-center rounded-full text-white/90 backdrop-blur-sm transition-colors [@media(hover:none)]:h-8",
                confirmDel
                  ? "bg-destructive px-2"
                  : "size-6 bg-black/45 hover:bg-black/65 [@media(hover:none)]:size-8",
              )}
            >
              {confirmDel ? (
                <span className="text-[0.65rem] font-semibold">Sure?</span>
              ) : (
                <Trash2 className="size-3" />
              )}
            </button>
          </Tip>
        </div>

        <div className="pointer-events-auto flex items-center justify-center gap-1 p-2">
          <Tip label="Download PNG">
            <a
              href={gen.image}
              download={`${slugify(displayName)}.png`}
              onClick={(e) => e.stopPropagation()}
              aria-label="Download PNG"
              className={pill}
            >
              <Download className="size-3.5" />
            </a>
          </Tip>
          <Tip label="Download SVG (auto-traced)">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSvg();
              }}
              disabled={svgBusy}
              aria-label="Download SVG"
              className={pill}
            >
              {svgBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileCode2 className="size-3.5" />
              )}
            </button>
          </Tip>
          <DropdownMenu>
            <Tip label={gen.folderId ? "Change folder" : "Move to folder"}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  // The tile itself opens the logo on click and on Enter/Space;
                  // both have to stop here or the menu opens the lightbox too.
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-label="Move to folder"
                  className={cn(pill, gen.folderId && "text-primary")}
                >
                  <FolderInput className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent
              align="center"
              className="max-h-64 w-52 overflow-y-auto"
              // The menu is portalled in the DOM but still a child in the React
              // tree, and React bubbles synthetic events along THAT tree: without
              // this, picking a folder also fired the tile's onClick and threw
              // the lightbox open on top of the history panel.
              onClick={(e) => e.stopPropagation()}
            >
              {folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() =>
                    onMoveToFolder(gen.id, gen.folderId === f.id ? null : f.id)
                  }
                >
                  <Check
                    className={cn(
                      "size-3.5 shrink-0",
                      gen.folderId === f.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{f.name}</span>
                </DropdownMenuItem>
              ))}
              {folders.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => onNewFolderFor(gen.id)}>
                <FolderPlus className="size-3.5 shrink-0" />
                New folder…
              </DropdownMenuItem>
              {gen.folderId && (
                <DropdownMenuItem
                  onSelect={() => onMoveToFolder(gen.id, null)}
                  className="text-destructive focus:text-destructive"
                >
                  <FolderMinus className="size-3.5 shrink-0" />
                  Remove from folder
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip label={hasKit ? "Open brand kit" : "Create brand kit"}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCreateBrandKit(gen);
              }}
              aria-label={hasKit ? "Open brand kit" : "Create brand kit"}
              className={cn(pill, hasKit && "text-primary")}
            >
              {hasKit ? (
                <Package className="size-3.5" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </button>
          </Tip>
          <Tip label="Load into creator">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onLoad(gen.params);
              }}
              aria-label="Load into creator"
              className={pill}
            >
              <FolderOpen className="size-3.5" />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
