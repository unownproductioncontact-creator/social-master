"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Bouton « Copier la légende » pour une cible TikTok en mode brouillon (le mode brouillon TikTok
 * n'a pas de champ caption côté API — le user doit la coller lui-même dans l'app, cf. CLAUDE.md §2).
 * Reproduit EXACTEMENT le format composé par le worker (src/worker/publish-job.ts) :
 *   hashtagLine = hashtags.map(h => `#${h}`).join(" ")
 *   caption     = [captionOverride ?? post.caption, hashtagLine].filter(Boolean).join("\n\n")
 */
export function CopyCaptionButton({
  caption,
  hashtags,
  captionOverride,
}: {
  caption: string;
  hashtags: string[];
  captionOverride?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const hashtagLine = hashtags.map((h) => `#${h}`).join(" ");
    const fullCaption = [captionOverride ?? caption, hashtagLine].filter(Boolean).join("\n\n");

    navigator.clipboard.writeText(fullCaption).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleCopy();
      }}
      className={cn(copied && "text-primary")}
    >
      {copied ? (
        <>
          <Check className="size-3.5" />
          Copiée !
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          Copier la légende
        </>
      )}
    </Button>
  );
}
