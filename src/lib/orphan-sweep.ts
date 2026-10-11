/**
 * Sélection PURE des objets R2 orphelins — présents dans le bucket mais plus référencés par aucun
 * média de la base (CLAUDE.md §36, point 5 : balayage mensuel R2 ↔ base). Aucune I/O : le job
 * (src/worker/orphan-sweep-job.ts) liste le bucket par le Worker, charge les clés de la base, appelle
 * cette fonction, puis supprime. Testée (src/lib/orphan-sweep.test.ts).
 *
 * D'où viennent les orphelins : une suppression de média dont la partie R2 a échoué (best-effort), des
 * miniatures envoyées avant le correctif de suppression de juillet, des copies `.converted.jpg` jamais
 * effacées, un import interrompu après l'écriture par le Worker.
 */
import type { BucketObject } from "@/lib/media-worker";

/** Seul ce préfixe est balayé : jamais un objet posé ailleurs (essais, fichiers de service). */
export const SWEPT_PREFIX = "media/";
/** Un objet plus récent que ça n'est jamais supprimé (envoi ou import encore en cours, base pas à jour). */
export const ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Plafond de suppressions par passage : le reste attend le mois suivant. */
export const ORPHAN_MAX_DELETIONS = 500;

export type OrphanSelection = {
  /** Objets à supprimer ce mois-ci : les plus anciens d'abord, dans la limite du plafond. */
  orphans: BucketObject[];
  orphanBytes: number;
  /** Nombre total d'orphelins éligibles, plafond non appliqué (sert au garde-fou). */
  eligible: number;
  /** Objets inspectés (sous le préfixe balayé). */
  inspected: number;
  /** Non référencés mais trop récents pour être touchés. */
  tooRecent: number;
};

export function selectOrphanObjects(
  objects: BucketObject[],
  referenced: ReadonlySet<string>,
  now: Date,
  options: { minAgeMs?: number; max?: number } = {}
): OrphanSelection {
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const max = options.max ?? ORPHAN_MAX_DELETIONS;

  let inspected = 0;
  let tooRecent = 0;
  const candidates: Array<{ object: BucketObject; uploadedMs: number }> = [];

  for (const object of objects) {
    if (!object.key.startsWith(SWEPT_PREFIX)) continue;
    inspected++;
    if (referenced.has(object.key)) continue;
    const uploadedMs = object.uploaded ? Date.parse(object.uploaded) : NaN;
    // Date illisible = on ne sait pas l'âge de l'objet : on n'y touche pas.
    if (!Number.isFinite(uploadedMs) || now.getTime() - uploadedMs < minAgeMs) {
      tooRecent++;
      continue;
    }
    candidates.push({ object, uploadedMs });
  }

  candidates.sort((a, b) => a.uploadedMs - b.uploadedMs);
  const orphans = candidates.slice(0, Math.max(0, max)).map((c) => c.object);
  return {
    orphans,
    orphanBytes: orphans.reduce((sum, o) => sum + o.size, 0),
    eligible: candidates.length,
    inspected,
    tooRecent,
  };
}

/**
 * Garde-fou avant toute suppression : un nombre d'orphelins anormal (la moitié du bucket, au-delà
 * d'une dizaine) signale presque sûrement une base mal branchée ou un listing tronqué, pas un vrai
 * ménage — on s'arrête et on prévient plutôt que de supprimer.
 */
export function orphanCountLooksSafe(orphanCount: number, inspected: number): boolean {
  if (orphanCount <= 10) return true;
  return orphanCount <= inspected / 2;
}
