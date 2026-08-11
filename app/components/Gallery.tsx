"use client";

import { forwardRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import {
  Download,
  FileCode2,
  FolderOpen,
  ImageOff,
  Package,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { downloadBlob, slugify } from "@/app/lib/brand-kit";
import { logoToSvgBlob } from "@/app/lib/svg-export";
import { Tip } from "./ui/tooltip";
import { LogoMark } from "./Logo";

export type ImageModel = "auto" | "flash" | "gemini-pro" | "gpt-image" | "flux";

export type GenParams = {
  companyName: string;
  selectedStyle: string;
  logoType: string;
  primaryColor: string;
  backgroundColor: string;
  detailLevel: string;
  monochrome: boolean;
  additionalInfo: string;
  referenceDescription?: string;
  /** Optional: logos saved before the engine picker existed have no value. */
  imageModel?: ImageModel;
};

export type Generation = {
  id: string;
  image: string;
  companyName: string;
  params: GenParams;
  createdAt?: number;
  favorite?: boolean;
  name?: string; // user-given label, overrides companyName for display
  /** The custom folder this logo is filed in, if any (at most one). */
  folderId?: string;
  /** Hydrated from on-device history (skips the new-logo entry animation). */
  restored?: boolean;
};

const EASE = [0.22, 1, 0.36, 1] as const;

function SkeletonCell() {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="shimmer relative flex aspect-square flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-border bg-card"
    >
      <span className="spinner-ring size-7" />
      <span className="text-xs font-medium text-muted-foreground">
        Generating…
      </span>
    </motion.div>
  );
}

// forwardRef is required, not cosmetic: AnimatePresence's popLayout mode has to
// take a ref to the exiting cell to pull it out of the grid flow. Without one it
// silently never unmounts the cell, and a deleted logo stays on screen.
const GenerationCell = forwardRef<
  HTMLDivElement,
  {
    gen: Generation;
    index: number;
    busy: boolean;
    hasKit: boolean;
    onVary: (gen: Generation) => void;
    onOpen: (gen: Generation) => void;
    onCreateBrandKit: (gen: Generation) => void;
    onToggleFavorite: (gen: Generation) => void;
    onDelete: (id: string) => void;
  }
>(function GenerationCell(
  {
    gen,
    index,
    busy,
    hasKit,
    onVary,
    onOpen,
    onCreateBrandKit,
    onToggleFavorite,
    onDelete,
  },
  ref,
) {
  const [imgFailed, setImgFailed] = useState(false);
  const [svgBusy, setSvgBusy] = useState(false);
  // Two-step confirm: deleting is unrecoverable and the cells are small.
  const [confirmDel, setConfirmDel] = useState(false);
  const fallbackName = gen.name || gen.companyName || `Logo ${index + 1}`;

  async function handleSvg() {
    if (svgBusy) return;
    setSvgBusy(true);
    try {
      const blob = await logoToSvgBlob(gen.image);
      downloadBlob(blob, `${slugify(fallbackName)}.svg`);
    } catch {
      toast({ variant: "destructive", title: "Couldn't vectorize this logo" });
    } finally {
      setSvgBusy(false);
    }
  }
  return (
    <motion.div
      ref={ref}
      layout
      // Restored history cells paint in place: the entry stagger is for
      // genuinely new logos, not a reload of last week's.
      initial={gen.restored ? false : { opacity: 0, scale: 0.94, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      // No exit animation on purpose. Under framer-motion 12 + React 19 the exit
      // never settles here, so AnimatePresence kept the cell mounted forever and
      // a deleted logo stayed on screen until a reload. Unmounting straight away
      // is worth more than a fade nobody was getting.
      transition={{
        duration: 0.38,
        ease: EASE,
        delay: Math.min(index, 6) * 0.035,
      }}
      onClick={() => onOpen(gen)}
      // Leaving the card disarms a pending delete, so it can never sit armed
      // waiting for an unrelated click when you come back.
      onMouseLeave={() => setConfirmDel(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(gen);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${fallbackName}`}
      className="group relative aspect-square cursor-pointer overflow-hidden rounded-2xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {imgFailed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <ImageOff className="size-6 opacity-60" />
          <span className="px-3 text-center text-xs">Image unavailable</span>
        </div>
      ) : (
        <Image
          src={gen.image}
          alt={`${fallbackName} logo`}
          width={512}
          height={512}
          unoptimized
          priority={index < 3}
          onError={() => setImgFailed(true)}
          className="h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.04]"
        />
      )}
      {/* Favorite star: always visible when favorited, else on hover/focus */}
      <Tip
        label={gen.favorite ? "Remove from favorites" : "Add to favorites"}
        side="right"
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
            "absolute left-2 top-2 z-10 flex size-7 items-center justify-center rounded-full border bg-black/45 outline-none backdrop-blur-md transition-all duration-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:size-9",
            gen.favorite
              ? "border-amber-300/40 text-amber-300 opacity-100"
              : // No hover on touch: keep the star reachable there.
                "border-white/15 text-white/85 opacity-0 hover:text-white group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <Star className={cn("size-3.5", gen.favorite && "fill-amber-300")} />
        </button>
      </Tip>
      {/* Top-right cluster: the style label reads at a glance across the whole
          grid (the alternative is opening each logo just to tell two similar
          directions apart), with the kit badge keeping its place beside it. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        {gen.params.selectedStyle && (
          <span className="pointer-events-none rounded-full border border-white/15 bg-black/55 px-2 py-1 text-[0.65rem] font-medium text-white opacity-0 shadow-sm backdrop-blur-md transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            {gen.params.selectedStyle}
          </span>
        )}
        {hasKit && (
          <Tip label="Open brand kit" side="left">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCreateBrandKit(gen);
              }}
              aria-label="Open brand kit"
              className="flex items-center gap-1 rounded-full border border-white/15 bg-primary/90 px-2 py-1 text-[0.65rem] font-semibold text-primary-foreground shadow-sm outline-none backdrop-blur-md transition-colors hover:bg-primary focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:py-1.5"
            >
              <Package className="size-3" strokeWidth={2.5} />
              Kit
            </button>
          </Tip>
        )}
      </div>
      {/* Revealed on hover OR keyboard focus; always visible on touch (no hover there) */}
      <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/45 via-black/0 to-transparent opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <div className="pointer-events-auto mb-3 flex items-center gap-1 rounded-full border border-white/15 bg-black/55 p-1 backdrop-blur-md">
          <Tip label="Download PNG">
            <a
              href={gen.image}
              download={`${slugify(gen.companyName)}.png`}
              onClick={(e) => e.stopPropagation()}
              aria-label="Download PNG"
              className="flex size-8 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/15 focus-visible:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:size-9"
            >
              <Download className="size-4" />
            </a>
          </Tip>
          <Tip label={hasKit ? "Open brand kit" : "Create brand kit"}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCreateBrandKit(gen);
              }}
              aria-label={hasKit ? "Open brand kit" : "Create brand kit"}
              className="flex size-8 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/15 focus-visible:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:size-9"
            >
              {hasKit ? (
                <Package className="size-4" />
              ) : (
                <Sparkles className="size-4" />
              )}
            </button>
          </Tip>
          <Tip label={svgBusy ? "Vectorizing…" : "Download SVG (auto-traced)"}>
            <button
              type="button"
              disabled={svgBusy}
              onClick={(e) => {
                e.stopPropagation();
                handleSvg();
              }}
              aria-label="Download SVG"
              className="flex size-8 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/15 focus-visible:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-40 [@media(hover:none)]:size-9"
            >
              {svgBusy ? (
                <span className="spinner-ring size-4" />
              ) : (
                <FileCode2 className="size-4" />
              )}
            </button>
          </Tip>
          <Tip label={busy ? "Still generating…" : "Make variations"}>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onVary(gen);
              }}
              aria-label="Make variations of this logo"
              className="flex size-8 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/15 focus-visible:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-40 [@media(hover:none)]:size-9"
            >
              <RefreshCw className="size-4" />
            </button>
          </Tip>
          <span aria-hidden className="mx-0.5 h-5 w-px bg-white/20" />
          <Tip label={confirmDel ? "Click again to delete" : "Delete"}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (confirmDel) onDelete(gen.id);
                else setConfirmDel(true);
              }}
              onBlur={() => setConfirmDel(false)}
              aria-label={confirmDel ? "Confirm delete" : "Delete"}
              className={cn(
                "flex h-8 items-center justify-center rounded-full text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:none)]:h-9",
                confirmDel
                  ? "bg-destructive px-2.5 text-[0.65rem] font-semibold"
                  : "w-8 hover:bg-white/15 focus-visible:bg-white/20 [@media(hover:none)]:w-9",
              )}
            >
              {confirmDel ? "Sure?" : <Trash2 className="size-4" />}
            </button>
          </Tip>
        </div>
      </div>
    </motion.div>
  );
});

export default function Gallery({
  generations,
  pendingCount,
  savedKitIds,
  filterLabel,
  onClearFilter,
  onVary,
  onOpen,
  onCreateBrandKit,
  onToggleFavorite,
  onDelete,
}: {
  generations: Generation[];
  pendingCount: number;
  savedKitIds: Set<string>;
  /** Set when the grid is narrowed to a folder or brand (drives the empty state). */
  filterLabel?: string;
  onClearFilter?: () => void;
  onVary: (gen: Generation) => void;
  onOpen: (gen: Generation) => void;
  onCreateBrandKit: (gen: Generation) => void;
  onToggleFavorite: (gen: Generation) => void;
  onDelete: (id: string) => void;
}) {
  if (generations.length === 0 && pendingCount === 0) {
    // An empty FILTERED grid is a different situation from an empty app, and
    // the first-run copy there ("your logos will appear here") reads as if the
    // logos were lost. Name the filter and offer the way back out.
    if (filterLabel) {
      return (
        <div className="flex h-full min-h-[16rem] flex-col items-center justify-center px-8 py-16 text-center">
          <FolderOpen className="size-10 text-muted-foreground/40" />
          <h2 className="mt-4 text-base font-bold text-foreground">
            Nothing in {filterLabel} yet
          </h2>
          <p className="mt-1.5 max-w-xs text-pretty text-sm text-muted-foreground">
            Generate with this selected, or move logos in from your history.
          </p>
          {onClearFilter && (
            <button
              type="button"
              onClick={onClearFilter}
              className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show all logos
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-[16rem] flex-col items-center justify-center px-8 py-16 text-center">
        <LogoMark className="animate-pulse-soft size-12 opacity-25" />
        <h2 className="mt-5 text-lg font-bold text-foreground">
          Your logos will appear here
        </h2>
        <p className="mt-1.5 max-w-xs text-pretty text-sm text-muted-foreground">
          Pick a quick-start preset or fill in the details, hit Generate, and
          every logo you make stacks up right here.
        </p>
      </div>
    );
  }

  // Strictly the order handed in, which is newest-first. This used to pin
  // favorites to the front, and that quietly broke the main feedback loop of the
  // app: with even one old logo starred, a logo you just generated appeared
  // BELOW it rather than at the top, so it read as if the generation had not
  // landed at all. Starring something is not a request to reorder the feed —
  // the star already marks it, and the history dialog has a favorites-only
  // filter for actually browsing them.
  return (
    <div className="grid grid-cols-2 gap-3.5 p-5 sm:gap-4 sm:p-6 lg:grid-cols-3">
      <AnimatePresence initial={false}>
        {Array.from({ length: pendingCount }, (_, i) => (
          <SkeletonCell key={`skeleton-${i}`} />
        ))}
        {generations.map((gen, i) => (
          <GenerationCell
            key={gen.id}
            gen={gen}
            index={i}
            busy={pendingCount > 0}
            hasKit={savedKitIds.has(gen.id)}
            onVary={onVary}
            onOpen={onOpen}
            onCreateBrandKit={onCreateBrandKit}
            onToggleFavorite={onToggleFavorite}
            onDelete={onDelete}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
