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
 * Image servant de miniature YouTube (CLAUDE.md §37) encore attendue (nouvel essai programmé) ou en
 * échec (l'utilisateur peut la reposer avec set_youtube_thumbnail) : jamais purgée. Une fois la
 * miniature posée (SET), l'image suit la règle commune.
 */
export function thumbnailStillNeeded(thumbnailStatuses: ReadonlyArray<string | null>): boolean {
  return thumbnailStatuses.some((status) => status === "PENDING" || status === "FAILED");
}

/**
 * Retourne les identifiants des médias purgeables : uniquement ceux dont TOUTES les publications
 * sont parties (`allPostsResolved`), aucune publication en attente (`inUseByPendingPost` faux), et
 * dont la dernière publication est antérieure à `now − retentionDays`. Un média jamais utilisé
 * (`lastPublishedAt` null) n'est JAMAIS purgé — prudence délibérée.
 *
 * `retentionDays === 0` = mode « Dès la publication » : le cutoff vaut `now`, donc tout média
 * entièrement publié (avant l'instant présent) est purgeable — c'est le filet de sécurité quotidien
 * du mode immédiat (la purge en temps réel se fait dans le worker, cf. purgeMediaForPublishedPost).
 * Une rétention NÉGATIVE ou non finie ne purge rien (garde-fou anti-configuration erronée).
 */
export function selectPurgeableMedia(
  assets: RetentionCandidate[],
  retentionDays: number,
  now: Date
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return [];

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

// ---------------------------------------------------------------------------------------------
// Médias JAMAIS utilisés (CLAUDE.md §36, point 5 — demande du user, délai de 30 jours confirmé le
// 11/10/2026). Distinct de la rétention ci-dessus (médias déjà PUBLIÉS, réglable par le user) : ici,
// un fichier envoyé ou importé mais rattaché à AUCUN post — un essai, un doublon, un envoi oublié.
// ---------------------------------------------------------------------------------------------

export const UNUSED_MEDIA_MAX_AGE_DAYS = 30;

export type UnusedMediaCandidate = {
  id: string;
  createdAt: Date;
  /** Nombre de posts (brouillon, programmé, publié…) qui utilisent ce média. */
  postCount: number;
};

/**
 * Identifiants des médias à supprimer : AUCUN post ne les utilise (un brouillon suffit à les protéger)
 * et ils ont été ajoutés il y a STRICTEMENT plus de `maxAgeDays` jours. Frontière stricte comme
 * `selectPurgeableMedia` : exactement à la limite, on garde. Un délai non fini ou ≤ 0 ne supprime rien.
 */
export function selectUnusedStaleMedia(
  assets: UnusedMediaCandidate[],
  now: Date,
  maxAgeDays: number = UNUSED_MEDIA_MAX_AGE_DAYS
): string[] {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return [];
  const cutoffMs = now.getTime() - maxAgeDays * MS_PER_DAY;
  return assets.filter((a) => a.postCount === 0 && a.createdAt.getTime() < cutoffMs).map((a) => a.id);
}

/**
 * Jours restants avant la suppression automatique d'un média non utilisé (0 = au prochain passage).
 * Sert à l'affichage dans la médiathèque ; ne fait pas foi pour la suppression elle-même.
 */
export function daysBeforeUnusedPurge(createdAt: Date, now: Date, maxAgeDays: number = UNUSED_MEDIA_MAX_AGE_DAYS): number {
  const remainingMs = createdAt.getTime() + maxAgeDays * MS_PER_DAY - now.getTime();
  return Math.max(0, Math.ceil(remainingMs / MS_PER_DAY));
}
