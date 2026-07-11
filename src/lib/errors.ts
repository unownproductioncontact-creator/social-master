export type ErrorClass = "transient" | "content_rejected" | "account_issue";

// Sous-ensemble des codes "account_issue" qui signifient spécifiquement que le token/la connexion
// est invalide (par opposition à un quota, qui se résout tout seul sans reconnexion).
const REAUTH_CODES = new Set([
  "ig_token_invalid",
  "ig_restricted",
  "tt_token_invalid",
  "tt_banned",
  "yt_token_invalid",
  "yt_no_channel",
]);

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

// ---------------------------------------------------------------------------
// YouTube (Google) — deux formats d'erreur coexistent (CLAUDE.md §25) :
//   • API googleapis : { "error": { "code": 403, "message": "...",
//         "errors": [{ "reason": "quotaExceeded", "domain": "youtube.quota", "message": "..." }],
//         "status": "PERMISSION_DENIED" } }   → error est un OBJET, la raison porte l'info clé.
//   • OAuth (oauth2.googleapis.com/token) : { "error": "invalid_grant",
//         "error_description": "Token has been expired or revoked." }  → error est une CHAÎNE.
// Le provider injecte le corps brut dans le message d'erreur (throw new Error("... : ${text}")).
// ---------------------------------------------------------------------------

type GoogleErrorFields = {
  code: number | null;
  reason: string | null;
  oauthError: string | null;
  status: string | null;
};

function extractGoogleError(message: string): GoogleErrorFields {
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as {
        error?: unknown;
      };
      const err = parsed.error;
      // Format OAuth : `error` est une chaîne (ex. "invalid_grant").
      if (typeof err === "string") {
        return { code: null, reason: null, oauthError: err, status: null };
      }
      // Format API : `error` est un objet { code, status, errors: [{ reason }] }.
      if (err && typeof err === "object") {
        const e = err as { code?: number; status?: string; errors?: Array<{ reason?: string }> };
        const reason = Array.isArray(e.errors) && e.errors[0]?.reason ? String(e.errors[0].reason) : null;
        return {
          code: typeof e.code === "number" ? e.code : null,
          reason,
          oauthError: null,
          status: typeof e.status === "string" ? e.status : null,
        };
      }
    } catch {
      // Corps tronqué/malformé : on retombe sur l'analyse par regex du message (plus bas).
    }
  }
  return { code: null, reason: null, oauthError: null, status: null };
}

// Le quota videos.insert (100/j) ET les limites de débit se réinitialisent seuls — décision produit
// §25 : on les classe en "account_issue" NON-reauth (pas de retry en boucle, message d'attente).
const YT_QUOTA_REASONS = /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded|uploadLimitExceeded/;
// Métadonnées/média invalides ou traitement échoué → refus PERMANENT, jamais retenté.
const YT_CONTENT_REASONS = /invalidTitle|invalidDescription|invalidTags|invalidVideoMetadata|invalidCategoryId|invalidFilename|invalidRecordingDetails|mediaBodyRequired|failedPrecondition|processingFailure|uploadRejected/;
// Auth/permission → reconnexion (le user doit re-consentir, y compris réaccorder youtube.upload s'il
// l'a refusé → insufficientPermissions). `forbidden` seul reste ambigu → traité en contenu (voir plus bas).
const YT_REAUTH_REASONS = /authError|insufficientPermissions|unauthorized|invalidCredentials/;

/**
 * Classifie une erreur de publication/OAuth YouTube (CLAUDE.md §25). Ordre : marqueur « pas de chaîne »
 * → OAuth invalid_grant → quota → contenu invalide → auth/permission (401 ou raison) → 403 nu (contenu,
 * prudent) → 5xx/backend (transitoire) → défaut transitoire. Ne retente JAMAIS un rejet de contenu ; un
 * problème de token met le compte en NEEDS_REAUTH (géré par l'appelant via needsReauth()).
 */
export function classifyYouTubeError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const { code, reason, oauthError, status } = extractGoogleError(message);

  // Aucune chaîne YouTube sur le compte Google (marqueur interne provider ou raison API) → reconnexion
  // après création d'une chaîne.
  if (reason === "youtubeSignupRequired" || /youtubeSignupRequired/.test(message)) {
    return {
      errorClass: "account_issue",
      code: "yt_no_channel",
      message: "Aucune chaîne YouTube sur ce compte Google — créez une chaîne puis reconnectez le compte.",
    };
  }

  // OAuth : échange/refresh refusé (token expiré ou révoqué) → reconnexion. Détecté via le champ `error`
  // (chaîne) OU en clair dans le message (couvre aussi un throw interne "invalid_grant: ...").
  if (
    (oauthError && /invalid_grant|invalid_client|unauthorized_client|invalid_scope/.test(oauthError)) ||
    /\binvalid_grant\b/.test(message)
  ) {
    return {
      errorClass: "account_issue",
      code: "yt_token_invalid",
      message: "Connexion YouTube expirée ou révoquée — reconnectez votre compte.",
    };
  }

  // Quota videos.insert / limites de débit → réessayer plus tard (pas de retry automatique).
  if ((reason && YT_QUOTA_REASONS.test(reason)) || (reason == null && YT_QUOTA_REASONS.test(message))) {
    return {
      errorClass: "account_issue",
      code: "yt_quota",
      message: "Quota YouTube atteint — réessayez demain (le quota se réinitialise à minuit heure du Pacifique).",
    };
  }

  // Contenu refusé (titre/description/média invalides, traitement échoué) → jamais retenté.
  if ((reason && YT_CONTENT_REASONS.test(reason)) || /yt_processing_failed/.test(message)) {
    return {
      errorClass: "content_rejected",
      code: "yt_content_rejected",
      message: "YouTube a refusé cette vidéo (titre, description ou fichier invalide).",
    };
  }

  // Auth/permission insuffisante (401, ou raison d'authentification) → reconnexion. Couvre le cas où
  // l'utilisateur n'a pas accordé youtube.upload (insufficientPermissions).
  if (code === 401 || (reason && YT_REAUTH_REASONS.test(reason))) {
    return {
      errorClass: "account_issue",
      code: "yt_token_invalid",
      message: "Connexion YouTube expirée ou autorisation insuffisante — reconnectez votre compte.",
    };
  }

  // 403 sans raison reconnue : ni quota, ni auth identifiée. On le traite en refus de contenu (pas de
  // retry) PLUTÔT qu'en reconnexion, pour ne pas mettre à tort tout le compte en pause sur un rejet
  // ponctuel (règle §6.4 : ne jamais retenter un rejet, mais ne pauser le compte que sur un vrai souci
  // de token, qui remonterait en 401/authError déjà traités au-dessus).
  if (code === 403) {
    return {
      errorClass: "content_rejected",
      code: "yt_forbidden",
      message: "YouTube a refusé cette publication (accès interdit pour cette vidéo).",
    };
  }

  // 5xx / indisponibilité / erreur backend Google → transitoire (retry backoff existant).
  if (
    (code !== null && code >= 500) ||
    (status !== null && /UNAVAILABLE|INTERNAL/.test(status)) ||
    /backendError|internalError/.test(message)
  ) {
    return {
      errorClass: "transient",
      code: "yt_server_error",
      message: "Erreur serveur YouTube, nouvelle tentative en cours.",
    };
  }

  return { errorClass: "transient", code: "yt_unknown", message: "Erreur YouTube inattendue, nouvelle tentative en cours." };
}
