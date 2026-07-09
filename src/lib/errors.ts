export type ErrorClass = "transient" | "content_rejected" | "account_issue";

// Sous-ensemble des codes "account_issue" qui signifient spécifiquement que le token/la connexion
// est invalide (par opposition à un quota, qui se résout tout seul sans reconnexion).
const REAUTH_CODES = new Set(["ig_token_invalid", "ig_restricted", "tt_token_invalid", "tt_banned"]);

export function needsReauth(code: string): boolean {
  return REAUTH_CODES.has(code);
}

export type ClassifiedError = {
  errorClass: ErrorClass;
  code: string;
  message: string; // message FR affiché à l'utilisateur
};

/**
 * Extrait `error.code` et `error.error_subcode` (ENTIERS) du corps JSON Meta injecté dans le message
 * d'erreur (graphFetch fait `throw new Error(... : ${await res.text()})`). On matche sur ces champs
 * précis et JAMAIS sur le blob entier : sinon un chiffre présent dans le `fbtrace_id` (chaîne opaque
 * alphanumérique, ex. "A190x458Z") ferait basculer à tort vers ig_token_invalid → NEEDS_REAUTH sur un
 * compte parfaitement valide (bug identifié à l'audit du 09/07).
 */
function extractMetaError(message: string): { code: number | null; subcode: number | null } {
  const jsonStart = message.indexOf('{"error"');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as {
        error?: { code?: number; error_subcode?: number };
      };
      const e = parsed.error ?? {};
      return {
        code: typeof e.code === "number" ? e.code : null,
        subcode: typeof e.error_subcode === "number" ? e.error_subcode : null,
      };
    } catch {
      // Corps tronqué/malformé : repli sur l'extraction ciblée des champs numériques.
    }
  }
  const codeM = message.match(/"code"\s*:\s*(-?\d+)/);
  const subM = message.match(/"error_subcode"\s*:\s*(-?\d+)/);
  return {
    code: codeM ? Number(codeM[1]) : null,
    subcode: subM ? Number(subM[1]) : null,
  };
}

const IG_MEDIA_SUBCODES = new Set([2207004, 2207008, 2207028, 2207035, 2207036, 2207037, 2207038, 2207039, 2207040]);
const IG_REAUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

/**
 * Classifie une erreur de publication Instagram selon les codes documentés (voir CLAUDE.md §2 et §4).
 * Ne retente JAMAIS un rejet de contenu ; un problème de compte doit mettre le compte en NEEDS_REAUTH
 * (géré par l'appelant). Reconnaît aussi les MARQUEURS INTERNES levés par le provider pour distinguer
 * un conteneur en ERROR (contenu invalide, permanent) d'un simple délai (transitoire).
 */
export function classifyInstagramError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  // Marqueurs internes (waitForContainerReady) — pas des codes Meta, matchés en clair sans risque.
  if (message.includes("ig_container_error")) {
    return { errorClass: "content_rejected", code: "ig_media_invalid", message: "Instagram a refusé ce média (le traitement du conteneur a échoué)." };
  }
  if (message.includes("ig_container_expired") || message.includes("ig_container_timeout")) {
    return { errorClass: "transient", code: "ig_not_ready", message: "Le média n'était pas encore prêt, nouvelle tentative en cours." };
  }

  const { code, subcode } = extractMetaError(message);

  // Média pas encore prêt (publication trop tôt) → re-poll / transitoire.
  if (code === 9007 || subcode === 2207027) {
    return { errorClass: "transient", code: "ig_not_ready", message: "Le média n'était pas encore prêt, nouvelle tentative en cours." };
  }
  // Quota de publication atteint (fenêtre glissante 24 h).
  if (code === 9 || subcode === 2207042) {
    return { errorClass: "account_issue", code: "ig_quota", message: "Quota de publication Instagram atteint pour aujourd'hui." };
  }
  // Spam (rejet de contenu) — 4/2207051 confirmé « spam » pour la variante Instagram, PAS un rate-limit.
  if (code === 4 || subcode === 2207051) {
    return { errorClass: "content_rejected", code: "ig_spam_flag", message: "Instagram a signalé ce contenu comme spam potentiel." };
  }
  // Compte restreint → action dans l'app Instagram.
  if (code === 25 || subcode === 2207050) {
    return { errorClass: "account_issue", code: "ig_restricted", message: "Compte Instagram restreint — connectez-vous dans l'app Instagram pour lever la restriction." };
  }
  // Token invalide/expiré → reconnexion (190 + sous-codes 458–467).
  if (code === 190 || (subcode !== null && IG_REAUTH_SUBCODES.has(subcode))) {
    return { errorClass: "account_issue", code: "ig_token_invalid", message: "Connexion Instagram expirée — reconnectez votre compte." };
  }
  // Média non conforme (specs format/ratio/durée).
  if (code === 36000 || (subcode !== null && IG_MEDIA_SUBCODES.has(subcode))) {
    return { errorClass: "content_rejected", code: "ig_media_invalid", message: "Instagram a refusé ce média (format, ratio ou légende invalide)." };
  }
  // Rate-limit générique app-level → transitoire.
  if (code === 80002 || code === 429 || code === 17) {
    return { errorClass: "transient", code: "ig_rate_limited", message: "Limite de requêtes Instagram atteinte, nouvelle tentative en cours." };
  }
  return { errorClass: "transient", code: "ig_unknown", message: "Erreur Instagram inattendue, nouvelle tentative en cours." };
}

export function classifyTikTokError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  if (/spam_risk_too_many_posts|spam_risk_too_many_pending_share/.test(message)) {
    return { errorClass: "account_issue", code: "tt_quota", message: "Quota de publication TikTok atteint pour aujourd'hui." };
  }
  if (/spam_risk_user_banned_from_posting/.test(message)) {
    return { errorClass: "account_issue", code: "tt_banned", message: "TikTok a temporairement bloqué la publication sur ce compte." };
  }
  if (/access_token_invalid|scope_not_authorized/.test(message)) {
    return { errorClass: "account_issue", code: "tt_token_invalid", message: "Connexion TikTok expirée — reconnectez votre compte." };
  }
  if (/rate_limit_exceeded/.test(message)) {
    return { errorClass: "transient", code: "tt_rate_limited", message: "Limite de requêtes TikTok atteinte, nouvelle tentative en cours." };
  }
  if (/url_ownership_unverified/.test(message)) {
    return { errorClass: "content_rejected", code: "tt_url_unverified", message: "Domaine média non vérifié auprès de TikTok." };
  }
  if (/privacy_level_option_mismatch|invalid_param/.test(message)) {
    return { errorClass: "content_rejected", code: "tt_invalid_param", message: "TikTok a refusé les paramètres de cette publication." };
  }
  return { errorClass: "transient", code: "tt_unknown", message: "Erreur TikTok inattendue, nouvelle tentative en cours." };
}
