import "server-only";

/**
 * Config SSL node-postgres partagée entre Prisma (src/lib/db.ts) et pg-boss (src/worker/boss.ts).
 *
 * Pourquoi en code plutôt que via `?sslmode=` dans DATABASE_URL : le Session pooler Supabase
 * présente un certificat que Node rejette (`SELF_SIGNED_CERT_IN_CHAIN`) avec `sslmode=require`,
 * et le comportement de `sslmode=no-verify` dépend de la version du parseur d'URL de `pg`.
 * Une option `ssl` explicite passée à la Pool prime toujours sur ce que dit l'URL — c'est donc
 * le seul moyen déterministe, indépendant de ce que contient la variable d'environnement.
 *
 * TLS reste actif (trafic chiffré) ; seule la vérification du certificat est désactivée —
 * pratique standard avec node-postgres + pooler Supabase. Pour une vérification complète, il
 * faudrait embarquer le certificat CA de Supabase (non justifié pour ce projet perso).
 */
export function pgSslConfig(): { rejectUnauthorized: false } | undefined {
  const url = process.env.DATABASE_URL ?? "";
  // En local (serveur `prisma dev`), pas de TLS du tout — laisser l'URL décider.
  if (/localhost|127\.0\.0\.1/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}
