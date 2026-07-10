/**
 * Fenêtre glissante TikTok — module PUR et importable côté client (AUCUN import serveur/db/"server-only").
 *
 * TikTok plafonne les brouillons « en attente » à 5 par tranche de 24 h glissante (au-delà :
 * `spam_risk_too_many_pending_share`). Le plafond ne porte PAS sur le nombre total d'un lot mais sur
 * le maximum de brouillons contenus dans une même fenêtre de 24 h : 7 vidéos étalées sur 7 jours ne
 * violent jamais le plafond (chaque fenêtre de 24 h n'en contient qu'une). Ce module fournit la
 * primitive testable qui mesure ça correctement (P1-4).
 */

/** Durée de la fenêtre glissante TikTok en millisecondes (24 h). */
export const TIKTOK_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Nombre MAXIMUM d'éléments contenus dans une même fenêtre glissante de `windowMs`.
 *
 * La fenêtre est **demi-ouverte** `[t, t + windowMs)` et ancrée successivement sur chaque élément :
 * un élément situé exactement à `t + windowMs` appartient déjà à la fenêtre suivante (bord exclu),
 * ce qui colle à la sémantique « 5 par 24 h » (le 6ᵉ brouillon exactement 24 h après le 1ᵉʳ ouvre une
 * nouvelle fenêtre). Implémentation en O(n log n) : tri + deux pointeurs.
 *
 * @param timesMs horodatages en millisecondes (ordre quelconque, doublons autorisés).
 * @param windowMs largeur de la fenêtre en millisecondes.
 * @returns le plus grand nombre d'éléments tenant dans une fenêtre de `windowMs` (0 si vide).
 */
export function maxCountInSlidingWindow(timesMs: number[], windowMs: number): number {
  if (timesMs.length === 0) return 0;

  const sorted = [...timesMs].sort((a, b) => a - b);
  let max = 0;
  let right = 0;

  for (let left = 0; left < sorted.length; left++) {
    // `right` ne recule jamais quand `left` avance (fenêtre monotone) → coût amorti O(n).
    if (right < left) right = left;
    // Étend `right` tant que sorted[right] est dans [sorted[left], sorted[left] + windowMs).
    while (right < sorted.length && sorted[right] - sorted[left] < windowMs) {
      right++;
    }
    const count = right - left;
    if (count > max) max = count;
  }

  return max;
}
