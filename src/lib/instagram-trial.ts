/**
 * Réels d'essai Instagram (« trial reels ») — CLAUDE.md §34.
 *
 * Doc Meta (POST /{ig-user-id}/media, vérifiée le 06/10/2026, API v25.0) : paramètre `trial_params` =
 * { graduation_strategy } ; « The media_type must be REELS if this parameter is included ». Un réel
 * d'essai n'est d'abord montré qu'aux non-abonnés, puis partagé aux abonnés (« graduation ») :
 *   - MANUAL : par l'utilisateur, dans l'app Instagram ;
 *   - SS_PERFORMANCE : automatiquement par Instagram si le réel marche bien.
 * L'API ne permet ni de lire l'état de l'essai ni de le partager ensuite. Pas de collaborateurs sur un
 * réel d'essai : règle Instagram relevée par Metricool, absente de la doc Meta.
 *
 * Module PUR (partagé composer ↔ service ↔ worker ↔ connecteur), testé dans instagram-trial.test.ts.
 */

export const INSTAGRAM_TRIAL_STRATEGIES = ["MANUAL", "SS_PERFORMANCE"] as const;
export type InstagramTrialStrategy = (typeof INSTAGRAM_TRIAL_STRATEGIES)[number];

export const INSTAGRAM_TRIAL_REEL_ONLY_ERROR =
  "Réel d'essai : uniquement pour un Reel Instagram (une seule vidéo, hors Story).";
export const INSTAGRAM_TRIAL_COLLABORATORS_ERROR =
  "Un réel d'essai ne peut pas avoir de collaborateurs (règle Instagram).";

/** Lit la stratégie stockée dans PostTarget.platformOptions.trial (null = Reel classique). */
export function trialFromOptions(platformOptions: unknown): InstagramTrialStrategy | null {
  const value = (platformOptions as { trial?: unknown } | null)?.trial;
  return value === "MANUAL" || value === "SS_PERFORMANCE" ? value : null;
}

/** Valeurs du connecteur Claude (`instagram_trial_reel`), plus parlantes que les constantes Meta. */
export const TRIAL_STRATEGY_BY_CHOICE = { manual: "MANUAL", auto: "SS_PERFORMANCE" } as const;
export type InstagramTrialChoice = keyof typeof TRIAL_STRATEGY_BY_CHOICE;

export function trialChoice(strategy: InstagramTrialStrategy | null): InstagramTrialChoice | undefined {
  if (strategy === "MANUAL") return "manual";
  if (strategy === "SS_PERFORMANCE") return "auto";
  return undefined;
}
