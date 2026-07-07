import "server-only";

/**
 * Config de connexion node-postgres partagée entre Prisma (src/lib/db.ts) et pg-boss
 * (src/worker/boss.ts).
 *
 * Pourquoi ce détour (vécu au premier déploiement Render, 08/07/2026) :
 * - Le Session pooler Supabase présente un certificat que Node rejette
 *   (`SELF_SIGNED_CERT_IN_CHAIN`) quand la vérification stricte est active.
 * - Dans pg 8.22 / pg-connection-string 2.x, `?sslmode=require` dans l'URL est traité
 *   comme un alias de `verify-full` (vérification STRICTE, avec warning de dépréciation)
 *   — contrairement à libpq où `require` ne vérifie pas le certificat.
 * - Piège décisif : dans `pg` (connection-parameters.js), le résultat du parsing de
 *   `connectionString` ÉCRASE la config explicite (`Object.assign({}, config, parse(cs))`).
 *   Passer `ssl: { rejectUnauthorized: false }` à la Pool ne sert donc à RIEN tant que
 *   l'URL contient un paramètre `sslmode` : le parseur émet sa propre clé `ssl` qui gagne.
 *
 * Correctif déterministe : retirer de l'URL tout paramètre lié au SSL, puis fournir la
 * config `ssl` explicite — qui, sans concurrent issu du parsing, s'applique enfin.
 * Résultat indépendant de ce que contient DATABASE_URL (require, no-verify, rien…).
 *
 * TLS reste actif vers Supabase (trafic chiffré) ; seule la vérification du certificat
 * est désactivée — standard avec node-postgres + pooler Supabase. La vérification
 * complète demanderait d'embarquer le CA Supabase (non justifié pour ce projet perso).
 * En local (serveur `prisma dev`, pas de TLS), ssl reste indéfini.
 *
 * NB : le `prisma db push` du script `start` lit l'URL BRUTE via prisma.config.ts — le
 * moteur Prisma (Rust) tolère ce certificat avec `sslmode=require`, aucun retrait requis.
 */

const SSL_URL_PARAMS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"];

export function pgConnectionConfig(): {
  connectionString: string;
  ssl: { rejectUnauthorized: false } | undefined;
} {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    for (const param of SSL_URL_PARAMS) {
      url.searchParams.delete(param);
    }
    return {
      connectionString: url.toString(),
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    };
  } catch {
    // URL vide ou non parsable : laisser pg se débrouiller avec la valeur brute
    // (comportement d'avant — échec explicite ECONNREFUSED plutôt que crash au chargement du module).
    return { connectionString: raw, ssl: undefined };
  }
}
