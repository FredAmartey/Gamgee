"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { ImageModel } from "./Gallery";

/**
 * Which image model draws the logo. "Auto" keeps the server's routing (Gemini
 * Flash for anything with lettering, FLUX for text-free marks), which is the
 * right default; the rest are here so the same prompt can be sent to a
 * different engine and compared side by side in the gallery.
 *
 * Prices are per image on Together and are worth showing: the spread between
 * the cheapest and Gemini 3 Pro is roughly 3x.
 */
export const IMAGE_MODELS: {
  key: ImageModel;
  label: string;
  note: string;
}[] = [
  { key: "auto", label: "Auto", note: "Picks per logo type" },
  { key: "flash", label: "Gemini Flash 3.1", note: "Fast · ~$0.05" },
  { key: "gemini-pro", label: "Gemini 3 Pro", note: "Sharpest · ~$0.13" },
  { key: "gpt-image", label: "GPT Image 2", note: "Stylised · ~$0.05" },
  { key: "flux", label: "FLUX.2 Pro", note: "Weak lettering · ~$0.03" },
];

export default function ModelSelect({
  value,
  onChange,
}: {
  value: ImageModel;
  onChange: (value: ImageModel) => void;
}) {
  const active = IMAGE_MODELS.find((m) => m.key === value) ?? IMAGE_MODELS[0];
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ImageModel)}>
      <SelectTrigger aria-label="Image model">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{active.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {active.note}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {IMAGE_MODELS.map((m) => (
          <SelectItem key={m.key} value={m.key}>
            <span className="flex flex-col">
              <span>{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.note}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
