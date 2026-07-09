import { Send } from "lucide-react";

/**
 * Marque « Social Master » (maquette) : tuile 24px rayon 7px en dégradé signature
 * contenant l'icône lucide Send (avion en papier) blanche 13px, suivie du nom en 14.5px bold.
 * Partagée entre la sidebar desktop et l'en-tête mobile.
 */
export function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="bg-brand-gradient flex size-6 shrink-0 items-center justify-center rounded-[7px]"
        aria-hidden="true"
      >
        <Send className="size-[13px] text-white" strokeWidth={2.4} />
      </span>
      <span className="text-[14.5px] font-bold tracking-tight">Social Master</span>
    </span>
  );
}
