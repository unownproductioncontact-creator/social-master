import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarClock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformChip } from "@/components/ui/platform-chip";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { getPublicMediaUrl } from "@/lib/storage";

/** Cible d'un post, aplatie pour l'affichage (horaire effectif déjà résolu côté serveur). */
type UpcomingTarget = {
  id: string;
  platform: string;
  /** Horaire effectif UTC (PostTarget.scheduledAt ?? Post.scheduledAt) ; null pour un brouillon. */
  scheduledAt: Date | null;
};

export type UpcomingPost = {
  id: string;
  caption: string;
  status: string;
  /** Clé de miniature réelle du premier média (thumbnailKey pour une vidéo, storageKey pour une image). */
  thumbnailKey: string | null;
  targets: UpcomingTarget[];
};

/**
 * Vignette 44px : miniature réelle si disponible (object-cover via le proxy /api/m/),
 * sinon dégradé sombre avec triangle « play » centré (maquette .thumb).
 */
function MediaThumb({ thumbnailKey }: { thumbnailKey: string | null }) {
  if (thumbnailKey) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={getPublicMediaUrl(thumbnailKey)}
        alt=""
        className="size-11 shrink-0 rounded-lg object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="relative size-11 shrink-0 rounded-lg bg-[linear-gradient(145deg,#2b2d3a,#4a4d63)]"
    >
      <span className="absolute inset-0 m-auto size-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-white/90 [transform:translateX(2px)]" />
    </span>
  );
}

/**
 * Puce plateforme + heure locale du user. Le fuseau du user (User.timezone) est appliqué
 * via formatInTimeZone (comme le reste du code) ; une cible sans horaire (brouillon) affiche
 * seulement le nom de la plateforme.
 */
function targetChip(target: UpcomingTarget, now: Date, timezone: string) {
  if (!target.scheduledAt) {
    return <PlatformChip key={target.id} platform={target.platform} />;
  }
  // « hier, HH:mm » si la publication a eu lieu la veille (jour calendaire du user), sinon HH:mm.
  const dayKey = (d: Date) => formatInTimeZone(d, timezone, "yyyy-MM-dd");
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const time = formatInTimeZone(target.scheduledAt, timezone, "HH:mm");
  const label =
    dayKey(target.scheduledAt) === dayKey(yesterday) ? `hier, ${time}` : time;
  return <PlatformChip key={target.id} platform={target.platform} time={label} />;
}

/**
 * Carte « Prochaines publications » (colonne gauche de la maquette) : liste dense des ~6 prochains
 * posts. Chaque ligne est cliquable → /composer/{postId}.
 */
export function UpcomingPostsCard({
  posts,
  now,
  timezone,
}: {
  posts: UpcomingPost[];
  now: Date;
  timezone: string;
}) {
  return (
    <Card className="gap-0 py-0">
      <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">
        Prochaines publications
      </h3>
      {posts.length === 0 ? (
        <div className="p-[15px]">
          <EmptyState
            icon={CalendarClock}
            title="Aucune publication à venir"
            description="Créez un post et programmez-le depuis le composer."
          />
        </div>
      ) : (
        <div className="flex flex-col">
          {posts.map((post) => (
            <Link
              key={post.id}
              href={`/composer/${post.id}`}
              className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] transition-colors last:border-b-0 hover:bg-muted/50"
            >
              <MediaThumb thumbnailKey={post.thumbnailKey} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold">
                  {post.caption || "(sans légende)"}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {post.targets.map((target) => targetChip(target, now, timezone))}
                </div>
              </div>
              <StatusBadge tone={postStatusTone(post.status)}>
                {postStatusLabel(post.status)}
              </StatusBadge>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
