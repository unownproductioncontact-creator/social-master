import { describe, it, expect, vi } from "vitest";
import { deliverTikTokDraft, decideTikTokPendingDraft, TIKTOK_CONFIRMATION_MAX_AGE_MS } from "@/lib/tiktok-draft";
import { TikTokPublishFailedError, TikTokStillProcessingError } from "@/lib/errors";

function deps(existingPublishId: string | null, waitForInbox: (id: string) => Promise<void> = async () => {}) {
  return {
    existingPublishId,
    start: vi.fn(async () => "pub_neuf"),
    savePublishId: vi.fn<(publishId: string | null) => Promise<void>>(async () => {}),
    waitForInbox: vi.fn(waitForInbox),
  };
}

describe("deliverTikTokDraft", () => {
  it("premier envoi : transmet le média une fois, persiste le publish_id AVANT d'attendre la livraison", async () => {
    const d = deps(null);
    const order: string[] = [];
    d.savePublishId.mockImplementation(async () => void order.push("save"));
    d.waitForInbox.mockImplementation(async () => void order.push("wait"));

    await deliverTikTokDraft(d);

    expect(d.start).toHaveBeenCalledTimes(1);
    expect(d.savePublishId).toHaveBeenCalledWith("pub_neuf");
    expect(d.waitForInbox).toHaveBeenCalledWith("pub_neuf");
    expect(order).toEqual(["save", "wait"]);
  });

  it("retry après délai dépassé : ne renvoie JAMAIS le média, reprend l'attente du même publish_id (doublons du 30/09)", async () => {
    const d = deps("pub_existant");

    await deliverTikTokDraft(d);

    expect(d.start).not.toHaveBeenCalled();
    expect(d.savePublishId).not.toHaveBeenCalled();
    expect(d.waitForInbox).toHaveBeenCalledWith("pub_existant");
  });

  it("délai dépassé : l'erreur remonte et le publish_id reste persisté pour la reprise", async () => {
    const d = deps(null, async (id) => {
      throw new TikTokStillProcessingError(id);
    });

    await expect(deliverTikTokDraft(d)).rejects.toBeInstanceOf(TikTokStillProcessingError);
    expect(d.savePublishId).toHaveBeenCalledTimes(1);
    expect(d.savePublishId).toHaveBeenCalledWith("pub_neuf");
  });

  it("statut FAILED : efface le publish_id (envoi mort) pour qu'un retry reparte d'un envoi neuf", async () => {
    const d = deps("pub_existant", async () => {
      throw new TikTokPublishFailedError("internal");
    });

    await expect(deliverTikTokDraft(d)).rejects.toBeInstanceOf(TikTokPublishFailedError);
    expect(d.savePublishId).toHaveBeenCalledWith(null);
  });

  it("échec pendant l'envoi (avant publish_id) : rien n'est persisté, le retry renverra", async () => {
    const d = deps(null);
    d.start.mockRejectedValueOnce(new Error("Envoi du chunk TikTok échoué (500)"));

    await expect(deliverTikTokDraft(d)).rejects.toThrow("chunk");
    expect(d.savePublishId).not.toHaveBeenCalled();
    expect(d.waitForInbox).not.toHaveBeenCalled();
  });
});

describe("decideTikTokPendingDraft", () => {
  const uploadedAt = new Date("2026-09-30T12:06:44Z");
  const minutesLater = (m: number) => new Date(uploadedAt.getTime() + m * 60_000);

  it("livré (boîte de réception ou déjà publié par le créateur) → delivered", () => {
    expect(decideTikTokPendingDraft({ status: "SEND_TO_USER_INBOX", uploadedAt, now: minutesLater(15) })).toBe("delivered");
    expect(decideTikTokPendingDraft({ status: "PUBLISH_COMPLETE", uploadedAt, now: minutesLater(300) })).toBe("delivered");
  });

  it("FAILED → failed, même tardif", () => {
    expect(decideTikTokPendingDraft({ status: "FAILED", uploadedAt, now: minutesLater(10) })).toBe("failed");
  });

  it("toujours en traitement ou statut illisible → wait tant que < 2 h, puis expired", () => {
    expect(decideTikTokPendingDraft({ status: "PROCESSING_UPLOAD", uploadedAt, now: minutesLater(30) })).toBe("wait");
    expect(decideTikTokPendingDraft({ status: null, uploadedAt, now: minutesLater(119) })).toBe("wait");
    expect(
      decideTikTokPendingDraft({ status: "PROCESSING_UPLOAD", uploadedAt, now: new Date(uploadedAt.getTime() + TIKTOK_CONFIRMATION_MAX_AGE_MS + 1) })
    ).toBe("expired");
    expect(decideTikTokPendingDraft({ status: null, uploadedAt, now: minutesLater(121) })).toBe("expired");
  });
});
