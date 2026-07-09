// Test d'intégration léger : exerce les vraies requêtes Prisma de quota.ts contre la base de dev
// locale (`npx prisma dev -d`, voir CLAUDE.md §13/§16). Même style que
// storage-check-job.integration.test.ts : fixtures créées en DB, fenêtres 24h vérifiées, nettoyage
// en afterAll. N'implique PAS pg-boss (aucune queue créée ici) — on insère directement des lignes
// PublishJob/PostTarget en base, donc pas exposé au piège de protocole documenté pour les jobs
// pg-boss fraîchement créés (celui-là ne concerne que scheduler.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { encryptToken } from "@/lib/crypto";
import {
  countTikTokDraftsInWindow,
  checkTikTokDraftCapacity,
  getInstagramQuotaSnapshot,
  TIKTOK_MAX_PENDING_DRAFTS_24H,
} from "@/lib/quota";

const TEST_EMAIL = "vitest-quota@test.local";
const HOUR = 60 * 60 * 1000;

let userId: string;
let tiktokAccountId: string;
let instagramAccountId: string;
let mediaAssetId: string;

/** Crée un Post + une PostTarget rattachée au compte donné. Statut/mode/plateforme paramétrables. */
async function createTarget(opts: {
  socialAccountId: string;
  platform: "TIKTOK" | "INSTAGRAM";
  publishMode: "AUTO" | "TIKTOK_DRAFT";
  contentType: "TIKTOK_VIDEO" | "IMAGE";
  status: "PENDING" | "PROCESSING" | "SENT_TO_INBOX" | "PUBLISHED" | "FAILED";
  publishedAt?: Date | null;
}) {
  const post = await db.post.create({ data: { userId, caption: "quota fixture", status: "SCHEDULED" } });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId, position: 0 } });
  const target = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId: opts.socialAccountId,
      platform: opts.platform,
      contentType: opts.contentType,
      publishMode: opts.publishMode,
      status: opts.status,
      publishedAt: opts.publishedAt ?? null,
    },
  });
  return { postId: post.id, targetId: target.id };
}

/** Insère un PublishJob (à venir ou non) directement en base, sans passer par pg-boss. */
async function createJob(postTargetId: string, state: "WAITING" | "ACTIVE" | "COMPLETED", runAt: Date) {
  await db.publishJob.create({
    data: { postTargetId, runAt, idempotencyKey: randomUUID(), state },
  });
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" },
  });
  userId = user.id;

  const tiktok = await db.socialAccount.create({
    data: {
      userId,
      platform: "TIKTOK",
      platformAccountId: "vitest-tt-account",
      username: "vitest_tt",
      accessTokenEnc: encryptToken("fake-tt-token"),
      status: "ACTIVE",
    },
  });
  tiktokAccountId = tiktok.id;

  const instagram = await db.socialAccount.create({
    data: {
      userId,
      platform: "INSTAGRAM",
      platformAccountId: "vitest-ig-account",
      username: "vitest_ig",
      accessTokenEnc: encryptToken("fake-ig-token"),
      status: "ACTIVE",
    },
  });
  instagramAccountId = instagram.id;

  const media = await db.mediaAsset.create({
    data: { userId, storageKey: "media/vitest-quota/fake.mp4", mimeType: "video/mp4", sizeBytes: 1000, status: "READY" },
  });
  mediaAssetId = media.id;
});

afterAll(async () => {
  // Cascade Prisma : supprimer le User supprime comptes, posts, targets, jobs, médias, logs.
  await db.user.delete({ where: { id: userId } }).catch(() => {});
});

describe("countTikTokDraftsInWindow (intégration DB)", () => {
  it("compte les brouillons TikTok déjà livrés (SENT_TO_INBOX) dans la fenêtre, exclut ceux hors fenêtre", async () => {
    // Dans la fenêtre : livré il y a 2h.
    await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "SENT_TO_INBOX",
      publishedAt: new Date(Date.now() - 2 * HOUR),
    });
    // Hors fenêtre : livré il y a 26h (> 24h) → ne doit PAS compter.
    await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "SENT_TO_INBOX",
      publishedAt: new Date(Date.now() - 26 * HOUR),
    });

    const count = await countTikTokDraftsInWindow({ socialAccountId: tiktokAccountId });
    expect(count).toBe(1);
  });

  it("compte les brouillons à venir (PublishJob WAITING/ACTIVE dans la fenêtre), pas les COMPLETED ni ceux au-delà de 24h", async () => {
    // À venir dans 3h, WAITING → compte.
    const waiting = await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "PENDING",
    });
    await createJob(waiting.targetId, "WAITING", new Date(Date.now() + 3 * HOUR));

    // À venir dans 1h, ACTIVE → compte aussi.
    const active = await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "PROCESSING",
    });
    await createJob(active.targetId, "ACTIVE", new Date(Date.now() + 1 * HOUR));

    // Job COMPLETED (déjà terminé, pas encore SENT_TO_INBOX dans ce fixture) → ne compte PAS.
    const completed = await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "PENDING",
    });
    await createJob(completed.targetId, "COMPLETED", new Date(Date.now() + 2 * HOUR));

    // WAITING mais prévu dans 30h (> fenêtre 24h) → ne compte PAS.
    const farFuture = await createTarget({
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      contentType: "TIKTOK_VIDEO",
      status: "PENDING",
    });
    await createJob(farFuture.targetId, "WAITING", new Date(Date.now() + 30 * HOUR));

    // On isole cette fenêtre du test précédent avec une petite fenêtre qui capte le SENT_TO_INBOX (2h)
    // + les 2 jobs à venir (1h, 3h) : total attendu = 3 (1 livré + 2 à venir).
    const count = await countTikTokDraftsInWindow({ socialAccountId: tiktokAccountId }, 24);
    expect(count).toBe(3);
  });

  it("ignore les cibles non-TikTok et les modes non-TIKTOK_DRAFT (ex. AUTO)", async () => {
    // Compte le baseline actuel du compte TikTok.
    const before = await countTikTokDraftsInWindow({ socialAccountId: tiktokAccountId });

    // Cible Instagram AUTO livrée récemment → ne doit PAS impacter le décompte TikTok.
    const ig = await createTarget({
      socialAccountId: instagramAccountId,
      platform: "INSTAGRAM",
      publishMode: "AUTO",
      contentType: "IMAGE",
      status: "PUBLISHED",
      publishedAt: new Date(Date.now() - 1 * HOUR),
    });
    await createJob(ig.targetId, "WAITING", new Date(Date.now() + 2 * HOUR));

    const after = await countTikTokDraftsInWindow({ socialAccountId: tiktokAccountId });
    expect(after).toBe(before);
  });

  it("le scoping par userId agrège les mêmes cibles que par socialAccountId (un seul compte TikTok ici)", async () => {
    const byAccount = await countTikTokDraftsInWindow({ socialAccountId: tiktokAccountId });
    const byUser = await countTikTokDraftsInWindow({ userId });
    expect(byUser).toBe(byAccount);
  });
});

describe("checkTikTokDraftCapacity", () => {
  it("autorise quand il reste de la place et renvoie remaining sans message", async () => {
    // Isolé sur un utilisateur neuf pour un décompte prévisible (aucun brouillon en attente).
    const freshUser = await db.user.create({
      data: { email: `vitest-quota-cap-${randomUUID()}@test.local`, passwordHash: "x" },
    });
    const account = await db.socialAccount.create({
      data: {
        userId: freshUser.id,
        platform: "TIKTOK",
        platformAccountId: `tt-${randomUUID()}`,
        username: "cap_ok",
        accessTokenEnc: encryptToken("fake"),
      },
    });

    const cap = await checkTikTokDraftCapacity({ socialAccountId: account.id }, 1);
    expect(cap.allowed).toBe(true);
    expect(cap.current).toBe(0);
    expect(cap.remaining).toBe(TIKTOK_MAX_PENDING_DRAFTS_24H);
    expect(cap.message).toBeUndefined();

    await db.user.delete({ where: { id: freshUser.id } }).catch(() => {});
  });

  it("bloque au-delà du plafond avec un message FR explicite mentionnant le compte actuel", async () => {
    const freshUser = await db.user.create({
      data: { email: `vitest-quota-cap-${randomUUID()}@test.local`, passwordHash: "x" },
    });
    const account = await db.socialAccount.create({
      data: {
        userId: freshUser.id,
        platform: "TIKTOK",
        platformAccountId: `tt-${randomUUID()}`,
        username: "cap_full",
        accessTokenEnc: encryptToken("fake"),
      },
    });
    const media = await db.mediaAsset.create({
      data: { userId: freshUser.id, storageKey: `m/${randomUUID()}`, mimeType: "video/mp4", sizeBytes: 1, status: "READY" },
    });

    // On remplit exactement le plafond (5 brouillons livrés dans la fenêtre).
    for (let i = 0; i < TIKTOK_MAX_PENDING_DRAFTS_24H; i++) {
      const post = await db.post.create({ data: { userId: freshUser.id, caption: "c", status: "SCHEDULED" } });
      await db.postMedia.create({ data: { postId: post.id, mediaAssetId: media.id, position: 0 } });
      await db.postTarget.create({
        data: {
          postId: post.id,
          socialAccountId: account.id,
          platform: "TIKTOK",
          contentType: "TIKTOK_VIDEO",
          publishMode: "TIKTOK_DRAFT",
          status: "SENT_TO_INBOX",
          publishedAt: new Date(Date.now() - 1 * HOUR),
        },
      });
    }

    const cap = await checkTikTokDraftCapacity({ socialAccountId: account.id }, 1);
    expect(cap.allowed).toBe(false);
    expect(cap.current).toBe(TIKTOK_MAX_PENDING_DRAFTS_24H);
    expect(cap.remaining).toBe(0);
    expect(cap.message).toBeTruthy();
    expect(cap.message).toContain("TikTok limite à 5 brouillons");
    expect(cap.message).toContain(String(TIKTOK_MAX_PENDING_DRAFTS_24H));

    await db.user.delete({ where: { id: freshUser.id } }).catch(() => {});
  });

  it("bloque un lot de 2 brouillons quand il ne reste qu'une place", async () => {
    const freshUser = await db.user.create({
      data: { email: `vitest-quota-cap-${randomUUID()}@test.local`, passwordHash: "x" },
    });
    const account = await db.socialAccount.create({
      data: {
        userId: freshUser.id,
        platform: "TIKTOK",
        platformAccountId: `tt-${randomUUID()}`,
        username: "cap_one_left",
        accessTokenEnc: encryptToken("fake"),
      },
    });
    const media = await db.mediaAsset.create({
      data: { userId: freshUser.id, storageKey: `m/${randomUUID()}`, mimeType: "video/mp4", sizeBytes: 1, status: "READY" },
    });

    // 4 brouillons déjà en attente ⇒ il reste 1 place ; demander 2 doit être refusé, 1 accepté.
    for (let i = 0; i < TIKTOK_MAX_PENDING_DRAFTS_24H - 1; i++) {
      const post = await db.post.create({ data: { userId: freshUser.id, caption: "c", status: "SCHEDULED" } });
      await db.postMedia.create({ data: { postId: post.id, mediaAssetId: media.id, position: 0 } });
      await db.postTarget.create({
        data: {
          postId: post.id,
          socialAccountId: account.id,
          platform: "TIKTOK",
          contentType: "TIKTOK_VIDEO",
          publishMode: "TIKTOK_DRAFT",
          status: "SENT_TO_INBOX",
          publishedAt: new Date(Date.now() - 1 * HOUR),
        },
      });
    }

    const two = await checkTikTokDraftCapacity({ socialAccountId: account.id }, 2);
    expect(two.allowed).toBe(false);
    expect(two.remaining).toBe(1);

    const one = await checkTikTokDraftCapacity({ socialAccountId: account.id }, 1);
    expect(one.allowed).toBe(true);

    await db.user.delete({ where: { id: freshUser.id } }).catch(() => {});
  });
});

describe("getInstagramQuotaSnapshot (tolérant aux erreurs)", () => {
  it("renvoie null pour un compte introuvable", async () => {
    const snap = await getInstagramQuotaSnapshot("does-not-exist");
    expect(snap).toBeNull();
  });

  it("renvoie null pour un compte non-Instagram (avant tout appel API)", async () => {
    const snap = await getInstagramQuotaSnapshot(tiktokAccountId);
    expect(snap).toBeNull();
  });

  it("renvoie null si l'appel API échoue (token bidon → fetch rejeté), sans jamais jeter", async () => {
    // Le compte IG de fixture a un token factice : l'appel réel à content_publishing_limit échoue,
    // la fonction doit avaler l'erreur et renvoyer null (pré-check non bloquant côté IG).
    const snap = await getInstagramQuotaSnapshot(instagramAccountId);
    expect(snap).toBeNull();
  });
});
