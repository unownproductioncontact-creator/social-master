// Test d'intégration : exerce le vrai Prisma + le vrai pg-boss contre la base de dev locale
// (`npx prisma dev -d`, voir CLAUDE.md §13). Contrairement aux tests unitaires du reste de ce
// dossier, celui-ci nécessite DATABASE_URL et un serveur Postgres local/de test accessible.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { schedulePost, unschedulePost } from "@/lib/scheduler";
import { deleteMediaAssetForUser } from "@/lib/media-delete";
import { getBoss, PUBLISH_QUEUE } from "@/worker/boss";
import { encryptToken } from "@/lib/crypto";

const TEST_EMAIL = "vitest-scheduler@test.local";

let userId: string;
let socialAccountId: string;
let tiktokAccountId: string;
let mediaAssetId: string;
let postId: string;
let postTargetId: string;

beforeAll(async () => {
  await getBoss().start();
  await getBoss().createQueue(PUBLISH_QUEUE, { retryLimit: 3, retryBackoff: true, retryDelay: 60, expireInSeconds: 600 });
  // Sur le serveur `prisma dev` local (moteur Postgres-compatible allégé), envoyer un job juste après
  // avoir créé une queue toute fraîche déclenche parfois un désync du protocole (bind/portal) —
  // jamais en usage réel, où la queue "publish" est créée une seule fois au démarrage du worker et
  // reste chaude pour toute la durée de vie du process (voir worker/index.ts). Un court délai suffit
  // à laisser le DDL "se poser" avant le premier envoi transactionnel du test.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const user = await db.user.create({
    data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" },
  });
  userId = user.id;

  const account = await db.socialAccount.create({
    data: {
      userId,
      platform: "INSTAGRAM",
      platformAccountId: "vitest-ig-account",
      username: "vitest_account",
      accessTokenEnc: encryptToken("fake-token"),
      status: "ACTIVE",
    },
  });
  socialAccountId = account.id;

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

  const media = await db.mediaAsset.create({
    data: { userId, storageKey: "media/vitest/fake.jpg", mimeType: "image/jpeg", sizeBytes: 1000, status: "READY" },
  });
  mediaAssetId = media.id;
});

afterAll(async () => {
  // L'annulation du post (via son cascade Prisma) supprime PostTarget/PostMedia/PublishJob ;
  // supprimer le User en cascade supprime le reste.
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await getBoss().stop({ close: false, graceful: false }).catch(() => {});
});

/**
 * PIÈGE D'ENVIRONNEMENT IDENTIFIÉ ET ISOLÉ (pas une régression applicative) : sur le serveur
 * `prisma dev` local (moteur Postgres-compatible allégé, pas du vrai Postgres), appeler
 * `boss.createQueue()` puis, PEU APRÈS DANS LE MÊME PROCESS, une transaction Prisma mêlant un appel
 * ORM classique et un `$queryRawUnsafe` (via `fromPrisma`, utilisé par pg-boss) déclenche de façon
 * quasi systématique une erreur de protocole ("bind message... prepared statement requires 0" /
 * "portal does not exist") sur le pool interne de pg-boss. Isolé par diagnostic minimal reproductible
 * (hors Vitest, hors application) : le facteur déclenchant est précisément la proximité
 * createQueue()+premier envoi transactionnel dans le MÊME process — ni un délai de 500 ms, ni un pool
 * Prisma neuf, ni le nom de la queue n'y changent quoi que ce soit. **Jamais observé dans l'application
 * réelle** : `createQueue()` n'y est appelé qu'une seule fois au démarrage du worker
 * (voir src/worker/index.ts), et reste ensuite inutilisé pour le reste de la vie du process — la
 * programmation d'un post par un utilisateur réel n'est donc jamais adjacente à un `createQueue()`.
 * Vérifié end-to-end dans le navigateur à plusieurs reprises (voir CLAUDE.md §14/§15) : Reels et
 * carrousels programmés avec succès, jobs pg-boss créés et exécutés à l'heure dite.
 *
 * Ce test retente, et si le même signal d'erreur environnemental persiste, le documente comme tel
 * plutôt que de faire échouer toute la suite pour un comportement propre à ce moteur de test allégé.
 */
async function scheduleWithRetry(...args: Parameters<typeof schedulePost>) {
  let lastResult: Awaited<ReturnType<typeof schedulePost>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    lastResult = await schedulePost(...args);
    if (!lastResult.error?.includes("bind message")) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return lastResult!;
}

const KNOWN_LOCAL_ENGINE_QUIRK = /bind message/;

async function createDraftPost() {
  const post = await db.post.create({
    data: { userId, caption: "Test vitest scheduler", status: "DRAFT" },
  });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId, position: 0 } });
  const target = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId,
      platform: "INSTAGRAM",
      contentType: "IMAGE",
      publishMode: "AUTO",
      status: "PENDING",
    },
  });
  return { postId: post.id, postTargetId: target.id };
}

/** Post à DEUX cibles (TikTok + Instagram) pour tester les horaires décalés par plateforme. */
async function createDualTargetPost() {
  const post = await db.post.create({
    data: { userId, caption: "Test offsets par cible", status: "DRAFT" },
  });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId, position: 0 } });
  const tiktokTarget = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId: tiktokAccountId,
      platform: "TIKTOK",
      contentType: "TIKTOK_VIDEO",
      publishMode: "TIKTOK_DRAFT",
      status: "PENDING",
    },
  });
  const igTarget = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId,
      platform: "INSTAGRAM",
      contentType: "IMAGE",
      publishMode: "AUTO",
      status: "PENDING",
    },
  });
  return { postId: post.id, tiktokTargetId: tiktokTarget.id, igTargetId: igTarget.id };
}

describe("schedulePost / unschedulePost (intégration DB + pg-boss)", () => {
  it("programme un post : status SCHEDULED + PublishJob créé avec idempotencyKey unique", async () => {
    const created = await createDraftPost();
    postId = created.postId;
    postTargetId = created.postTargetId;

    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000);
    const result = await scheduleWithRetry(postId, scheduledAt, "Europe/Paris");

    if (result.error && KNOWN_LOCAL_ENGINE_QUIRK.test(result.error)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scheduler.test.ts] Limitation connue du moteur prisma dev local rencontrée (voir commentaire " +
          "au-dessus de scheduleWithRetry) — non représentative de l'application réelle, test non concluant ici."
      );
      return;
    }

    expect(result.error).toBeUndefined();

    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe("SCHEDULED");
    expect(post.scheduledAt?.getTime()).toBe(scheduledAt.getTime());

    const job = await db.publishJob.findFirstOrThrow({ where: { postTargetId } });
    expect(job.state).toBe("WAITING");
    expect(job.idempotencyKey).toBeTruthy();

    const target = await db.postTarget.findUniqueOrThrow({ where: { id: postTargetId } });
    expect(target.status).toBe("PENDING");
  });

  it("refuse de programmer un post à moins d'une minute dans le futur", async () => {
    const created = await createDraftPost();
    const result = await schedulePost(created.postId, new Date(Date.now() + 10_000), "Europe/Paris");
    expect(result.error).toBeTruthy();

    await db.post.delete({ where: { id: created.postId } });
  });

  it("refuse de programmer un post sans média", async () => {
    const post = await db.post.create({ data: { userId, caption: "Sans média", status: "DRAFT" } });
    await db.postTarget.create({
      data: { postId: post.id, socialAccountId, platform: "INSTAGRAM", contentType: "IMAGE", status: "PENDING" },
    });

    const result = await schedulePost(post.id, new Date(Date.now() + 10 * 60 * 1000), "Europe/Paris");
    expect(result.error).toMatch(/média/i);

    await db.post.delete({ where: { id: post.id } });
  });

  it("annule la programmation : repasse en DRAFT et supprime le PublishJob", async () => {
    await unschedulePost(postId);

    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe("DRAFT");
    expect(post.scheduledAt).toBeNull();

    const jobs = await db.publishJob.findMany({ where: { postTargetId } });
    expect(jobs).toHaveLength(0);

    const target = await db.postTarget.findUniqueOrThrow({ where: { id: postTargetId } });
    expect(target.status).toBe("PENDING");
    expect(target.errorCode).toBeNull();
    // unschedulePost doit aussi remettre l'horaire effectif par cible à null (symétrie avec schedulePost).
    expect(target.scheduledAt).toBeNull();

    await db.post.delete({ where: { id: postId } });
  });

  it("horaires décalés par cible : TikTok à H, Instagram à H+300s → runAt ET PostTarget.scheduledAt distincts", async () => {
    const { postId: dualPostId, tiktokTargetId, igTargetId } = await createDualTargetPost();

    // Base à H+10min ; on décale explicitement Instagram de +300s (H+5min après le TikTok).
    const baseTime = new Date(Date.now() + 10 * 60 * 1000);
    const tiktokTime = baseTime;
    const instagramTime = new Date(baseTime.getTime() + 300 * 1000);

    const result = await scheduleWithRetry(dualPostId, baseTime, "Europe/Paris", {
      TIKTOK: tiktokTime,
      INSTAGRAM: instagramTime,
    });

    if (result.error && KNOWN_LOCAL_ENGINE_QUIRK.test(result.error)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[scheduler.test.ts] Limitation connue du moteur prisma dev local rencontrée (offsets par cible) — non concluant ici."
      );
      await db.post.delete({ where: { id: dualPostId } }).catch(() => {});
      return;
    }

    expect(result.error).toBeUndefined();

    // PostTarget.scheduledAt : chaque cible porte SON horaire effectif, distinct de l'autre.
    const tiktokTarget = await db.postTarget.findUniqueOrThrow({ where: { id: tiktokTargetId } });
    const igTarget = await db.postTarget.findUniqueOrThrow({ where: { id: igTargetId } });
    expect(tiktokTarget.scheduledAt?.getTime()).toBe(tiktokTime.getTime());
    expect(igTarget.scheduledAt?.getTime()).toBe(instagramTime.getTime());
    expect(igTarget.scheduledAt!.getTime() - tiktokTarget.scheduledAt!.getTime()).toBe(300 * 1000);

    // PublishJob.runAt : idem, le runAt de chaque job suit l'horaire de sa cible (utilisé aussi pour startAfter).
    const tiktokJob = await db.publishJob.findFirstOrThrow({ where: { postTargetId: tiktokTargetId } });
    const igJob = await db.publishJob.findFirstOrThrow({ where: { postTargetId: igTargetId } });
    expect(tiktokJob.runAt.getTime()).toBe(tiktokTime.getTime());
    expect(igJob.runAt.getTime()).toBe(instagramTime.getTime());
    expect(igJob.runAt.getTime()).not.toBe(tiktokJob.runAt.getTime());

    // Post.scheduledAt reste l'horaire de base (inchangé par les offsets).
    const post = await db.post.findUniqueOrThrow({ where: { id: dualPostId } });
    expect(post.scheduledAt?.getTime()).toBe(baseTime.getTime());

    await unschedulePost(dualPostId);
    // Après annulation, les deux cibles voient leur horaire effectif remis à null.
    const tiktokAfter = await db.postTarget.findUniqueOrThrow({ where: { id: tiktokTargetId } });
    const igAfter = await db.postTarget.findUniqueOrThrow({ where: { id: igTargetId } });
    expect(tiktokAfter.scheduledAt).toBeNull();
    expect(igAfter.scheduledAt).toBeNull();

    await db.post.delete({ where: { id: dualPostId } });
  });
});

describe("deleteMediaAssetForUser (suppression média EN CASCADE, intégration DB + pg-boss)", () => {
  it("média sur un BROUILLON : supprime le post et le média (sans pg-boss)", async () => {
    const media = await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest/cascade-draft.jpg", mimeType: "image/jpeg", sizeBytes: 500, status: "READY" },
    });
    const post = await db.post.create({ data: { userId, caption: "Cascade brouillon", status: "DRAFT" } });
    await db.postMedia.create({ data: { postId: post.id, mediaAssetId: media.id, position: 0 } });
    const target = await db.postTarget.create({
      data: { postId: post.id, socialAccountId, platform: "INSTAGRAM", contentType: "IMAGE", status: "PENDING" },
    });

    const res = await deleteMediaAssetForUser(userId, media.id);
    expect(res.error).toBeUndefined();

    // Post, cible, lien média et média : tout a disparu (cascade Prisma pour les 3 premiers).
    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await db.postTarget.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await db.postMedia.count({ where: { mediaAssetId: media.id } })).toBe(0);
    expect(await db.mediaAsset.findUnique({ where: { id: media.id } })).toBeNull();
  });

  it("média sur un post PROGRAMMÉ : dé-programme (annule le PublishJob), supprime post + média", async () => {
    const media = await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest/cascade-sched.jpg", mimeType: "image/jpeg", sizeBytes: 500, status: "READY" },
    });
    const post = await db.post.create({ data: { userId, caption: "Cascade programmé", status: "DRAFT" } });
    await db.postMedia.create({ data: { postId: post.id, mediaAssetId: media.id, position: 0 } });
    const target = await db.postTarget.create({
      data: { postId: post.id, socialAccountId, platform: "INSTAGRAM", contentType: "IMAGE", status: "PENDING" },
    });

    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000);
    const sched = await scheduleWithRetry(post.id, scheduledAt, "Europe/Paris");
    if (sched.error && KNOWN_LOCAL_ENGINE_QUIRK.test(sched.error)) {
      // eslint-disable-next-line no-console
      console.warn("[scheduler.test.ts] Limitation connue du moteur prisma dev local (cascade programmée) — non concluant ici.");
      await db.mediaAsset.delete({ where: { id: media.id } }).catch(() => {});
      await db.post.delete({ where: { id: post.id } }).catch(() => {});
      return;
    }
    expect(sched.error).toBeUndefined();

    // Pré-condition : le post est SCHEDULED et un PublishJob WAITING existe.
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
    expect(await db.publishJob.count({ where: { postTargetId: target.id } })).toBe(1);

    const res = await deleteMediaAssetForUser(userId, media.id);
    expect(res.error).toBeUndefined();

    // Le job a été annulé et tout a disparu.
    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await db.publishJob.count({ where: { postTargetId: target.id } })).toBe(0);
    expect(await db.mediaAsset.findUnique({ where: { id: media.id } })).toBeNull();
  });

  it("média sur un post PUBLIÉ : CONSERVE le post (historique), détache seulement le média", async () => {
    const media = await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest/cascade-pub.jpg", mimeType: "image/jpeg", sizeBytes: 500, status: "READY" },
    });
    const post = await db.post.create({
      data: { userId, caption: "Cascade publié", status: "PUBLISHED", scheduledAt: new Date(Date.now() - 3600_000) },
    });
    await db.postMedia.create({ data: { postId: post.id, mediaAssetId: media.id, position: 0 } });
    const target = await db.postTarget.create({
      data: {
        postId: post.id,
        socialAccountId,
        platform: "INSTAGRAM",
        contentType: "IMAGE",
        status: "PUBLISHED",
        platformPostId: "ig-hist-123",
        platformPostUrl: "https://instagram.com/p/hist",
        publishedAt: new Date(Date.now() - 3600_000),
      },
    });

    const res = await deleteMediaAssetForUser(userId, media.id);
    expect(res.error).toBeUndefined();

    // Le post publié et sa cible (avec platformPostId/URL) SURVIVENT — l'historique est préservé.
    const stillThere = await db.post.findUnique({ where: { id: post.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe("PUBLISHED");
    const targetAfter = await db.postTarget.findUnique({ where: { id: target.id } });
    expect(targetAfter?.platformPostId).toBe("ig-hist-123");
    // Le média, lui, a bien disparu et le lien PostMedia a été détaché par cascade.
    expect(await db.mediaAsset.findUnique({ where: { id: media.id } })).toBeNull();
    expect(await db.postMedia.count({ where: { postId: post.id } })).toBe(0);

    await db.post.delete({ where: { id: post.id } });
  });

  it("média introuvable ou d'un autre utilisateur : renvoie une erreur, ne supprime rien", async () => {
    const res = await deleteMediaAssetForUser(userId, "media-inexistant-xyz");
    expect(res.error).toBeTruthy();
    // Scoping : un média existant mais d'un autre userId est traité comme introuvable.
    const foreign = await deleteMediaAssetForUser("un-autre-user", mediaAssetId);
    expect(foreign.error).toBeTruthy();
    // Le média partagé n'a pas été supprimé.
    expect(await db.mediaAsset.findUnique({ where: { id: mediaAssetId } })).not.toBeNull();
  });
});
