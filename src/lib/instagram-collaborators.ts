/**
 * Collaborateurs Instagram (« collab ») — CLAUDE.md §28.
 *
 * Doc Meta (POST /{ig-user-id}/media, vérifiée le 30/09/2026) : paramètre `collaborators` = « For Feed
 * image, Reels and Carousels only. A list of up to 3 instagram usernames as collaborators on an ig
 * media. Not supported for Stories. » Chaque compte invité reçoit une invitation dans Instagram ; une
 * fois acceptée, le post apparaît aussi sur son profil.
 *
 * Module PUR (partagé composer ↔ action serveur ↔ worker), testé dans instagram-collaborators.test.ts.
 */

export const IG_COLLABORATORS_MAX = 3;

// Pseudo Instagram : lettres, chiffres, points et underscores, 30 caractères max (insensible à la casse).
const IG_USERNAME_RE = /^[a-z0-9._]{1,30}$/;

/**
 * Normalise une liste brute de pseudos : « @ » et espaces retirés, minuscules, vides et doublons écartés.
 * L'ordre de saisie est conservé.
 */
export function normalizeInstagramCollaborators(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const username = item.trim().replace(/^@+/, "").toLowerCase();
    if (username && !seen.has(username)) {
      seen.add(username);
      out.push(username);
    }
  }
  return out;
}

/** Découpe la saisie libre du composer (virgules, espaces ou retours à la ligne) puis normalise. */
export function parseInstagramCollaborators(input: string): string[] {
  return normalizeInstagramCollaborators(input.split(/[\s,;]+/));
}

/**
 * Message d'erreur en français, ou null si la liste (déjà normalisée) est acceptable.
 * `ownUsername` : le compte Instagram connecté, qui ne peut pas s'inviter lui-même.
 */
export function validateInstagramCollaborators(usernames: string[], ownUsername?: string | null): string | null {
  if (usernames.length > IG_COLLABORATORS_MAX) {
    return `${IG_COLLABORATORS_MAX} collaborateurs Instagram maximum.`;
  }
  const invalid = usernames.find((u) => !IG_USERNAME_RE.test(u));
  if (invalid) return `Pseudo Instagram invalide : « ${invalid} ».`;
  if (ownUsername && usernames.includes(ownUsername.trim().replace(/^@+/, "").toLowerCase())) {
    return "Vous ne pouvez pas vous inviter vous-même en collaboration.";
  }
  return null;
}

/** Lit la liste stockée dans PostTarget.platformOptions (tolère un JSON absent ou mal formé). */
export function collaboratorsFromOptions(platformOptions: unknown): string[] {
  const value = (platformOptions as { collaborators?: unknown } | null)?.collaborators;
  return Array.isArray(value) ? normalizeInstagramCollaborators(value.filter((v): v is string => typeof v === "string")) : [];
}
