import Link from "next/link";
import { Card } from "@/components/ui/card";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { CopyCaptionButton } from "@/components/history/copy-caption-button";

/** Post FAILED ou PARTIALLY_PUBLISHED (échec déjà résolu côté serveur au premier message d'erreur). */
export type ActionablePost = {
  id: string;
  caption: string;
  /** "FAILED" | "PARTIALLY_PUBLISHED" — alimente postStatusTone/postStatusLabel. */
  status: string;
  errorMessage: string | null;
};

/** Cible TikTok en mode brouillon arrivée dans l'inbox, en attente de finalisation manuelle. */
export type PendingTikTokDraft = {
  targetId: string;
  postId: string;
  caption: string;
  hashtags: string[];
  captionOverride: string | null;
};

/**
 * Carte « À traiter » (P2-2 + P1-5c) : tout ce qui attend une action du user, séparé de « Prochaines
 * publications » pour ne plus jamais mélanger un échec passé avec un post à venir. Deux sections
 * optionnelles — échecs/succès partiels (lien vers le composer) puis brouillons TikTok en attente
 * (légende à copier soi-même, cf. CLAUDE.md §2 : pas de champ caption sur l'API inbox TikTok).
 * Masquée entièrement s'il n'y a rien à traiter.
 */
export function NeedsAttentionCard({
  failedPosts,
  tiktokDrafts,
}: {
  failedPosts: ActionablePost[];
  tiktokDrafts: PendingTikTokDraft[];
}) {
  if (failedPosts.length === 0 && tiktokDrafts.length === 0) return null;

  return (
    <Card className="gap-0 py-0">
      <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">
        À traiter
      </h3>
      <div className="flex flex-col">
        {failedPosts.map((post) => (
          <Link
            key={post.id}
            href={`/composer/${post.id}`}
            className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0 transition-colors hover:bg-muted/50"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold">
                {post.caption || "(sans légende)"}
              </p>
              {post.errorMessage && (
                <p className="mt-0.5 truncate text-[12px] text-destructive">{post.errorMessage}</p>
              )}
            </div>
            <StatusBadge tone={postStatusTone(post.status)}>
              {postStatusLabel(post.status)}
            </StatusBadge>
          </Link>
        ))}
        {tiktokDrafts.map((draft) => (
          <div
            key={draft.targetId}
            className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0"
          >
            <Link
              href={`/composer/${draft.postId}`}
              className="block min-w-0 flex-1 truncate text-[13.5px] font-semibold hover:underline"
            >
              {draft.caption || "(sans légende)"}
            </Link>
            <div className="flex shrink-0 items-center gap-2">
              <CopyCaptionButton
                caption={draft.caption}
                hashtags={draft.hashtags}
                captionOverride={draft.captionOverride}
              />
              <StatusBadge tone={postStatusTone("SENT_TO_INBOX")}>
                {postStatusLabel("SENT_TO_INBOX")}
              </StatusBadge>
            </div>
          </div>
        ))}
      </div>
      {tiktokDrafts.length > 0 && (
        <p className="border-t border-border px-[15px] py-2.5 text-[11.5px] text-muted-foreground">
          La vidéo vous attend dans les notifications de l’app TikTok.
        </p>
      )}
    </Card>
  );
}
