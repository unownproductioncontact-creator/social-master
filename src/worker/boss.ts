import "server-only";
import { PgBoss, fromPrisma, type Db, type PrismaTransactionLike } from "pg-boss";
import { pgConnectionConfig } from "@/lib/db-ssl";

export const PUBLISH_QUEUE = "publish";
export const RECONCILE_QUEUE = "reconcile";
export const TOKEN_REFRESH_QUEUE = "token-refresh";
export const STORAGE_CHECK_QUEUE = "storage-check";
export const MEDIA_CLEANUP_QUEUE = "media-cleanup";
export const MEDIA_IMPORT_QUEUE = "media-import";
export const ORPHAN_SWEEP_QUEUE = "orphan-sweep";
export const YOUTUBE_THUMBNAIL_QUEUE = "youtube-thumbnail";
export const YOUTUBE_PUBLICATION_QUEUE = "youtube-publication";

/**
 * Délai entre deux interrogations de la base, par file (CLAUDE.md §42). Le défaut de pg-boss (2 s pour
 * chacune des 9 files, presque toujours vides) envoyait ~5 requêtes/s à Supabase jour et nuit : ~15 Go/mois
 * de bande passante sortante Render, au-delà des 5 Go inclus. 5 s là où quelqu'un attend (« Publier
 * maintenant », import par lien), 1 min pour les vérifications de fond, 5 min pour les crons quotidiens.
 */
export const POLLING_INTERVAL_SECONDS = {
  [PUBLISH_QUEUE]: 5,
  [MEDIA_IMPORT_QUEUE]: 5,
  [RECONCILE_QUEUE]: 60,
  [YOUTUBE_THUMBNAIL_QUEUE]: 60,
  [YOUTUBE_PUBLICATION_QUEUE]: 60,
  [TOKEN_REFRESH_QUEUE]: 300,
  [STORAGE_CHECK_QUEUE]: 300,
  [MEDIA_CLEANUP_QUEUE]: 300,
  [ORPHAN_SWEEP_QUEUE]: 300,
} as const;

// Une seule instance dans tout le process (web + worker in-process, voir instrumentation.ts).
declare global {
  // eslint-disable-next-line no-var
  var pgBossGlobal: PgBoss | undefined;
}

export function getBoss(): PgBoss {
  if (!globalThis.pgBossGlobal) {
    globalThis.pgBossGlobal = new PgBoss({
      ...pgConnectionConfig(),
      schema: "pgboss",
      // Pollers internes, 5 s chacun par défaut (§42) : le relais des crons (un cron ne vise pas la
      // seconde) et la résolution des dépendances entre jobs (fonction que l'app n'utilise pas).
      cronWorkerIntervalSeconds: 30,
      flowIntervalSeconds: 300,
    });
    globalThis.pgBossGlobal.on("error", (err) => console.error("[pg-boss]", err));
  }
  return globalThis.pgBossGlobal;
}

/** Permet d'enfiler un job DANS une transaction Prisma existante (voir règle d'ingénierie n°2). */
export function dbFromPrismaTx(tx: PrismaTransactionLike): Db {
  return fromPrisma(tx);
}
