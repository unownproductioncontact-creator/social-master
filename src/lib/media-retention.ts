/**
 * Sélection PURE des médias à purger par la rétention automatique (voir CLAUDE.md §15bis / audit P3-1c).
 * Aucune I/O : le worker (src/worker/media-cleanup-job.ts) charge les données en base, appelle cette
 * fonction, puis supprime les identifiants retournés via `deleteMediaAssetForUser`. Testée exhaustivement
 * (src/lib/media-retention.test.ts).
 */

export type RetentionCandidate = {
  id: string;
  /**
   * Le média est utilisé par AU MOINS un post ET TOUS ses posts sont `PUBLISHED`
   * (pas `DRAFT`/`SCHEDULED`/`FAILED`/`PARTIALLY_PUBLISHED`). Un média jamais utilisé est `false`.
   */
  allPostsResolved: boolean;
  /** Date de publication la plus récente parmi les posts du média (null si jamais publié). */
  lastPublishedAt: Date | null;
  /** Le média est référencé par au moins un post pas-encore-publié (garde-fou anti-purge). */
  inUseByPendingPost: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retourne les identifiants des médias purgeables : uniquement ceux dont TOUTES les publications
 * sont parties (`allPostsResolved`), aucune publication en attente (`inUseByPendingPost` faux), et
 * dont la dernière publication est antérieure à `now − retentionDays`. Un média jamais utilisé
 * (`lastPublishedAt` null) n'est JAMAIS purgé — prudence délibérée. Une rétention nulle ou négative
 * ne purge rien (on ne veut jamais tout supprimer par erreur de configuration).
 */
export function selectPurgeableMedia(
  assets: RetentionCandidate[],
  retentionDays: number,
  now: Date
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];

  const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;

  return assets
    .filter(
      (a) =>
        a.allPostsResolved &&
        !a.inUseByPendingPost &&
        a.lastPublishedAt != null &&
        a.lastPublishedAt.getTime() < cutoffMs
    )
    .map((a) => a.id);
}
