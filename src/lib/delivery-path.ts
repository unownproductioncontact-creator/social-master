/**
 * Par où est passé le fichier lors d'une publication (CLAUDE.md §36) : Worker Cloudflare (sortie
 * gratuite) ou Render (sortie facturée au-delà de 5 Go/mois). Enregistré dans le journal d'activité de
 * chaque livraison et relu par l'outil `get_post` du connecteur, pour pouvoir CONFIRMER qu'une
 * publication est bien passée par le Worker — un succès seul ne le prouve pas, la configuration
 * retombant sans bruit sur Render quand une variable manque. PUR, testé.
 */

export type DeliveryVia = "worker" | "render";

export type DeliveryPath = {
  via: DeliveryVia;
  /** media_url = la plateforme télécharge le fichier à une URL ; pull_from_url / file_upload = TikTok ;
   *  worker_push / render_stream = envoi YouTube. */
  method: "media_url" | "pull_from_url" | "file_upload" | "worker_push" | "render_stream";
};

/** Instagram (Reel, image, carrousel, story) et photos TikTok : la plateforme télécharge le fichier à une URL. */
export function mediaUrlDelivery(workerEnabled: boolean): DeliveryPath {
  return { via: workerEnabled ? "worker" : "render", method: "media_url" };
}

/** Vidéo TikTok : TikTok vient chercher le fichier (Worker) ou Render l'envoie par morceaux. */
export function tiktokVideoDelivery(workerEnabled: boolean): DeliveryPath {
  return workerEnabled ? { via: "worker", method: "pull_from_url" } : { via: "render", method: "file_upload" };
}

/** YouTube : le Worker pousse le fichier depuis R2 (`/push`) ou Render le diffuse lui-même. */
export function youtubeDelivery(pushConfigured: boolean): DeliveryPath {
  return pushConfigured ? { via: "worker", method: "worker_push" } : { via: "render", method: "render_stream" };
}

const METHODS = new Set<string>(["media_url", "pull_from_url", "file_upload", "worker_push", "render_stream"]);

/** Lecture tolérante du `detail` JSON d'une entrée du journal (null si absent ou malformé). */
export function readDelivery(detail: unknown): DeliveryPath | null {
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { delivery?: unknown }).delivery;
  if (typeof raw !== "object" || raw === null) return null;
  const { via, method } = raw as { via?: unknown; method?: unknown };
  if ((via !== "worker" && via !== "render") || typeof method !== "string" || !METHODS.has(method)) return null;
  return { via, method: method as DeliveryPath["method"] };
}

const LABELS: Record<DeliveryPath["method"], string> = {
  media_url: "la plateforme a téléchargé le fichier à une URL",
  pull_from_url: "TikTok a téléchargé le fichier à une URL",
  file_upload: "Render a envoyé le fichier à TikTok par morceaux",
  worker_push: "le Worker a poussé le fichier depuis R2",
  render_stream: "Render a diffusé le fichier depuis R2",
};

/** Phrase lisible pour l'utilisateur (ex. « Worker Cloudflare — TikTok a téléchargé le fichier à une URL »). */
export function describeDelivery(d: DeliveryPath): string {
  const where = d.via === "worker" ? "Worker Cloudflare" : "Render (sortie facturée au-delà de 5 Go/mois)";
  return `${where} — ${LABELS[d.method]}`;
}
