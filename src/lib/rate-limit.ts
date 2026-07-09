import "server-only";

/**
 * Limiteur de fréquence générique, en mémoire (Map clé → compteur), adapté à une instance
 * unique (Render free = mono-instance, pas de Redis à payer — voir CLAUDE.md §3/§6). Fenêtre
 * glissante simplifiée : on ne fait pas glisser précisément chaque requête, on remet juste le
 * compteur à zéro une fois `windowMs` écoulées depuis le premier hit de la fenêtre courante
 * (« fixed window », suffisant pour un usage mono-utilisateur — pas une garantie cryptographique
 * anti brute-force à l'échelle, juste un frein proportionné).
 *
 * ⚠️ Ne survit pas à un redémarrage du process (Map en RAM) — acceptable ici : le risque visé
 * (brute-force/abus en rafale) redémarre à zéro avec le process, ce n'est pas une régression de
 * sécurité pour un outil perso mono-instance.
 */

type Entry = { count: number; resetAt: number };

type RateLimitOptions = {
  /** Nombre maximum de tentatives autorisées dans la fenêtre. */
  max: number;
  /** Durée de la fenêtre en millisecondes. */
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Présent uniquement quand `allowed` est false : délai avant de pouvoir réessayer, arrondi à la seconde supérieure. */
  retryAfterSec?: number;
};

const store = new Map<string, Entry>();

/** Nettoyage paresseux : purge les entrées expirées à chaque appel plutôt qu'un setInterval dédié. */
function purgeExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

/**
 * Vérifie et enregistre une tentative pour `key`. Incrémente le compteur systématiquement
 * (même quand la limite est déjà dépassée), pour que les tentatives en rafale pendant le blocage
 * ne réinitialisent jamais la fenêtre prématurément.
 */
export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  purgeExpired(now);

  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true };
  }

  if (entry.count < options.max) {
    entry.count += 1;
    return { allowed: true };
  }

  entry.count += 1;
  const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
  return { allowed: false, retryAfterSec };
}

/** Réservé aux tests : vide entièrement le store pour isoler les cas. */
export function _resetRateLimitStoreForTests(): void {
  store.clear();
}
