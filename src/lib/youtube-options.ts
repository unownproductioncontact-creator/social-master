/**
 * Options d'une cible YouTube stockées dans `PostTarget.platformOptions` (contrat JSON partagé avec
 * `{ title?: string }`, CLAUDE.md §25). Module PUR, testé. Ajouté le 13/10/2026 (§37) : la visibilité,
 * pour pouvoir publier un Short de test non répertorié — défaut public, comme avant.
 */

export const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;
export type YouTubePrivacyStatus = (typeof YOUTUBE_PRIVACY_STATUSES)[number];

export const YOUTUBE_PRIVACY_LABELS: Record<YouTubePrivacyStatus, string> = {
  public: "publique",
  unlisted: "non répertoriée",
  private: "privée",
};

function isPrivacy(value: unknown): value is YouTubePrivacyStatus {
  return typeof value === "string" && (YOUTUBE_PRIVACY_STATUSES as readonly string[]).includes(value);
}

/** Visibilité demandée (lecture tolérante) : tout ce qui n'est pas une valeur connue = public. */
export function youtubePrivacyFromOptions(options: unknown): YouTubePrivacyStatus {
  if (typeof options !== "object" || options === null) return "public";
  const raw = (options as { privacy?: unknown }).privacy;
  return isPrivacy(raw) ? raw : "public";
}

/** Titre saisi (lecture tolérante) — absent si vide. */
export function youtubeTitleFromOptions(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const raw = (options as { title?: unknown }).title;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/** platformOptions d'une cible YouTube : on n'écrit que ce qui diffère du défaut. */
export function buildYouTubeOptions(title: string | null | undefined, privacy: YouTubePrivacyStatus): Record<string, string> {
  return {
    ...(title ? { title } : {}),
    ...(privacy !== "public" ? { privacy } : {}),
  };
}
