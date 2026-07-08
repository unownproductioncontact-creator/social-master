import "server-only";
import { PgBoss, fromPrisma, type Db, type PrismaTransactionLike } from "pg-boss";
import { pgConnectionConfig } from "@/lib/db-ssl";

export const PUBLISH_QUEUE = "publish";
export const RECONCILE_QUEUE = "reconcile";
export const TOKEN_REFRESH_QUEUE = "token-refresh";
export const STORAGE_CHECK_QUEUE = "storage-check";

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
    });
    globalThis.pgBossGlobal.on("error", (err) => console.error("[pg-boss]", err));
  }
  return globalThis.pgBossGlobal;
}

/** Permet d'enfiler un job DANS une transaction Prisma existante (voir règle d'ingénierie n°2). */
export function dbFromPrismaTx(tx: PrismaTransactionLike): Db {
  return fromPrisma(tx);
}
