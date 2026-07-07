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
 * Classifie une erreur de publication Instagram/TikTok selon les codes documentés
 * (voir CLAUDE.md §2 et §4). Ne retente JAMAIS un rejet de contenu ; un problème de
 * compte doit mettre le compte en NEEDS_REAUTH (géré par l'appelant).
 */
export function classifyInstagramError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  if (/9007|2207027/.test(message)) {
    return { errorClass: "transient", code: "ig_not_ready", message: "Le média n'était pas encore prêt, nouvelle tentative en cours." };
  }
  if (/\b9\b|2207042/.test(message)) {
    return { errorClass: "account_issue", code: "ig_quota", message: "Quota de publication Instagram atteint pour aujourd'hui." };
  }
  if (/\b4\b|2207051/.test(message)) {
    return { errorClass: "content_rejected", code: "ig_spam_flag", message: "Instagram a signalé ce contenu comme spam potentiel." };
  }
  if (/25|2207050/.test(message)) {
    return { errorClass: "account_issue", code: "ig_restricted", message: "Compte Instagram restreint — connectez-vous dans l'app Instagram pour lever la restriction." };
  }
  if (/190|458|459|460|463|464|467/.test(message)) {
    return { errorClass: "account_issue", code: "ig_token_invalid", message: "Connexion Instagram expirée — reconnectez votre compte." };
  }
  if (/36000|2207004|2207008|2207028|2207035|2207036|2207037|2207038|2207039|2207040/.test(message)) {
    return { errorClass: "content_rejected", code: "ig_media_invalid", message: "Instagram a refusé ce média (format, ratio ou légende invalide)." };
  }
  if (/80002|429|17\b/.test(message)) {
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
