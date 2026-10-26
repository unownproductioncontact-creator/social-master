import "server-only";
import { getBoss, INSTAGRAM_STATS_QUEUE } from "@/worker/boss";

/**
 * Demande un relevé des statistiques Instagram d'un compte (après une reconnexion, depuis le connecteur, ou
 * par le cron qui en crée un par compte). Dédoublonné PAR COMPTE (file « stately » + singletonKey) : au plus
 * un relevé en attente et un en cours pour ce compte, sans jamais bloquer ceux des autres. Ne lève jamais :
 * un relevé manqué sera fait au passage suivant (toutes les 6 h).
 */
export async function requestInstagramStats(socialAccountId: string): Promise<boolean> {
  try {
    return (await getBoss().send(INSTAGRAM_STATS_QUEUE, { socialAccountId }, { singletonKey: socialAccountId })) !== null;
  } catch (err) {
    console.error("[instagram-stats] demande de relevé impossible", err);
    return false;
  }
}
