/**
 * Publication d'une vidéo sur une Page Facebook SANS doublon (CLAUDE.md §40) — module PUR (dépendances
 * injectées), testé sans base ni réseau.
 *
 * Même leçon que les brouillons TikTok (§27, incident du 30/09/2026) : une fois que Facebook détient une
 * vidéo PUBLIÉE (ou en cours de publication), un nouvel essai du job ne doit jamais la renvoyer — il
 * reprend seulement la vérification. L'avancement est donc noté dans `PostTarget.platformOptions.fbVideo`
 * à chaque étape :
 *  - « uploaded » : vidéo réservée et fichier reçu par Facebook, pas encore publiée (personne ne la voit) ;
 *  - « finished » : publication demandée — à partir d'ici on ne fait plus qu'attendre.
 */
import { FacebookPublishFailedError } from "@/lib/errors";

export type FacebookVideoProgress = { videoId: string; phase: "uploaded" | "finished" };

/** Avancement noté par une tentative précédente (lecture tolérante). */
export function readFacebookProgress(options: unknown): FacebookVideoProgress | null {
  if (typeof options !== "object" || options === null) return null;
  const raw = (options as { fbVideo?: unknown }).fbVideo;
  if (typeof raw !== "object" || raw === null) return null;
  const { videoId, phase } = raw as { videoId?: unknown; phase?: unknown };
  if (typeof videoId !== "string" || !videoId) return null;
  return phase === "uploaded" || phase === "finished" ? { videoId, phase } : null;
}

/** Options de la cible avec l'avancement mis à jour (null = l'oublier, pour repartir d'un envoi neuf). */
export function withFacebookProgress(options: unknown, progress: FacebookVideoProgress | null): Record<string, unknown> {
  const base = typeof options === "object" && options !== null ? { ...(options as Record<string, unknown>) } : {};
  delete base.fbVideo;
  return progress ? { ...base, fbVideo: progress } : base;
}

export type FacebookVideoDeps = {
  existing: FacebookVideoProgress | null;
  /** Reel : réserve la vidéo. Vidéo classique : envoie ET publie en un appel. Renvoie l'identifiant. */
  start: () => Promise<string>;
  /** Reel seulement : Facebook télécharge le fichier, puis publication demandée. */
  upload?: (videoId: string) => Promise<void>;
  finish?: (videoId: string) => Promise<void>;
  /** Reel seulement : la publication de cette vidéo a-t-elle déjà été demandée (tentative interrompue) ? */
  alreadyPublishing?: (videoId: string) => Promise<boolean>;
  save: (progress: FacebookVideoProgress | null) => Promise<void>;
  /** Attend la mise en ligne (lève FacebookStillProcessingError / FacebookPublishFailedError). */
  waitUntilPublished: (videoId: string) => Promise<void>;
};

/** Publie (ou reprend) la vidéo et attend sa mise en ligne. Renvoie l'identifiant de la vidéo. */
export async function deliverFacebookVideo(deps: FacebookVideoDeps): Promise<string> {
  let progress = deps.existing;

  // Tentative précédente arrêtée entre l'envoi du fichier et la publication : on vérifie chez Facebook
  // avant de redemander la publication (jamais deux fois la même vidéo en ligne).
  if (progress?.phase === "uploaded" && deps.finish) {
    if (!(deps.alreadyPublishing && (await deps.alreadyPublishing(progress.videoId)))) {
      await deps.finish(progress.videoId);
    }
    progress = { videoId: progress.videoId, phase: "finished" };
    await deps.save(progress);
  }

  if (!progress || progress.phase !== "finished") {
    const videoId = await deps.start();
    if (deps.upload && deps.finish) {
      await deps.upload(videoId);
      // Noté AVANT la demande de publication : si le process meurt juste après, le retry vérifie.
      await deps.save({ videoId, phase: "uploaded" });
      await deps.finish(videoId);
    }
    progress = { videoId, phase: "finished" };
    // Noté AVANT d'attendre : si l'attente expire, le retry reprend la vérification sans republier.
    await deps.save(progress);
  }

  try {
    await deps.waitUntilPublished(progress.videoId);
  } catch (err) {
    // Facebook a abandonné cette vidéo (rien n'est en ligne) : un éventuel retry repart d'un envoi neuf.
    if (err instanceof FacebookPublishFailedError) await deps.save(null);
    throw err;
  }
  return progress.videoId;
}

export type FacebookVideoStatus = {
  videoStatus?: string;
  uploading?: string;
  processing?: string;
  publishing?: string;
  publishStatus?: string;
  errors: string[];
};

export type FacebookVideoDecision = "published" | "processing" | "failed";

/**
 * Lecture du champ `status` d'une vidéo. Reel : en ligne quand la phase de publication est « complete ».
 * Vidéo classique (publiée dès l'envoi) : en ligne quand elle est « ready ». Statut ou phase « error » =
 * abandon.
 */
export function decideFacebookVideo(status: FacebookVideoStatus, kind: "reel" | "video"): FacebookVideoDecision {
  const phases = [status.uploading, status.processing, status.publishing];
  if (status.videoStatus === "error" || phases.includes("error") || status.errors.length > 0) return "failed";
  if (kind === "reel") {
    return status.publishing === "complete" || status.publishStatus === "published" ? "published" : "processing";
  }
  return status.videoStatus === "ready" ? "published" : "processing";
}
