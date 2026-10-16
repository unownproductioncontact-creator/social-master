import { describe, expect, it } from "vitest";
import {
  applyUpdateResponse,
  classifyVideoEditError,
  editScopeStatus,
  normalizePatch,
  normalizeTags,
  parseIsoDuration,
  parseYouTubeVideoRef,
  planVideoUpdate,
  readVideoDetails,
  tagsLength,
  utf8Bytes,
  validatePatch,
  type YouTubeVideoDetails,
} from "@/lib/youtube-video-edit";

const NOW = new Date("2026-10-16T12:00:00Z");

function video(overrides: Partial<YouTubeVideoDetails> = {}): YouTubeVideoDetails {
  return {
    id: "TLL5ihkt9cI",
    channelId: "UC_chaine",
    title: "Ils crachent sur 1 600 €",
    description: "Le marché devient fou\n\n#pokemon #cartepokemon",
    tags: ["pokemon", "carte pokemon"],
    categoryId: "20",
    defaultLanguage: "fr",
    defaultAudioLanguage: "fr",
    privacyStatus: "public",
    publishedAt: "2026-10-15T16:00:00Z",
    uploadStatus: "processed",
    embeddable: true,
    license: "youtube",
    publicStatsViewable: true,
    madeForKids: false,
    durationSec: 58,
    ...overrides,
  };
}

const scheduled = () => video({ privacyStatus: "private", publishAt: "2026-10-17T16:00:00Z" });

describe("droit de modification de la connexion", () => {
  it("youtube.upload + readonly ne suffisent pas ; force-ssl ou youtube oui ; liste vide = inconnue", () => {
    expect(editScopeStatus([])).toBe("unknown");
    expect(
      editScopeStatus(["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"])
    ).toBe("missing");
    expect(editScopeStatus(["https://www.googleapis.com/auth/youtube.force-ssl"])).toBe("granted");
    expect(editScopeStatus(["https://www.googleapis.com/auth/youtube"])).toBe("granted");
  });
});

describe("identifiant d'une vidéo à partir d'un lien", () => {
  it.each([
    ["TLL5ihkt9cI", "TLL5ihkt9cI"],
    ["https://www.youtube.com/shorts/TLL5ihkt9cI", "TLL5ihkt9cI"],
    ["youtube.com/shorts/TLL5ihkt9cI?feature=share", "TLL5ihkt9cI"],
    ["https://www.youtube.com/watch?v=TLL5ihkt9cI&t=12s", "TLL5ihkt9cI"],
    ["https://m.youtube.com/watch?v=TLL5ihkt9cI", "TLL5ihkt9cI"],
    ["https://youtu.be/TLL5ihkt9cI?si=abc", "TLL5ihkt9cI"],
    ["https://studio.youtube.com/video/TLL5ihkt9cI/edit", "TLL5ihkt9cI"],
    ["https://www.youtube.com/live/TLL5ihkt9cI", "TLL5ihkt9cI"],
  ])("%s → %s", (input, expected) => {
    expect(parseYouTubeVideoRef(input)).toBe(expected);
  });

  it("rien de reconnu → null", () => {
    expect(parseYouTubeVideoRef("https://www.youtube.com/@Pokemoha/shorts")).toBeNull();
    expect(parseYouTubeVideoRef("https://vimeo.com/123456")).toBeNull();
    expect(parseYouTubeVideoRef("pas un lien")).toBeNull();
  });
});

describe("lecture d'une ressource vidéo", () => {
  it("durées ISO 8601", () => {
    expect(parseIsoDuration("PT58S")).toBe(58);
    expect(parseIsoDuration("PT1M5S")).toBe(65);
    expect(parseIsoDuration("PT2H")).toBe(7200);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("n'importe quoi")).toBeUndefined();
  });

  it("snippet + status + contentDetails → détails ; sans id → null", () => {
    const details = readVideoDetails({
      id: "abcdefghijk",
      snippet: { channelId: "UC1", title: "T", description: "D", tags: ["a", 3], categoryId: "24", defaultAudioLanguage: "fr" },
      status: { privacyStatus: "private", publishAt: "2026-10-20T16:00:00Z", embeddable: false, madeForKids: false },
      contentDetails: { duration: "PT45S" },
    });
    expect(details).toMatchObject({
      id: "abcdefghijk",
      channelId: "UC1",
      tags: ["a"],
      categoryId: "24",
      privacyStatus: "private",
      publishAt: "2026-10-20T16:00:00Z",
      embeddable: false,
      durationSec: 45,
    });
    expect(readVideoDetails({ snippet: {} })).toBeNull();
  });

  it("après modification : les parties renvoyées remplacent, les autres restent", () => {
    const after = applyUpdateResponse(video(), { id: "TLL5ihkt9cI", snippet: { channelId: "UC_chaine", title: "Nouveau", description: "D", categoryId: "20" } });
    expect(after.title).toBe("Nouveau");
    expect(after.tags).toEqual([]);
    expect(after.privacyStatus).toBe("public");
    expect(after.durationSec).toBe(58);
  });
});

describe("tags et longueurs comptées comme YouTube", () => {
  it("doc YouTube : « Foo-Baz » = 7, « Foo Baz » = 9 (guillemets), virgules comprises", () => {
    expect(tagsLength(["Foo-Baz"])).toBe(7);
    expect(tagsLength(["Foo Baz"])).toBe(9);
    expect(tagsLength(["a", "b"])).toBe(3);
    expect(tagsLength([])).toBe(0);
  });

  it("nettoyage : # retiré, espaces resserrés, vides et doublons (casse ignorée) retirés", () => {
    expect(normalizeTags(["#Pokemon", "  carte   pokemon ", "pokemon", "", "#"])).toEqual(["Pokemon", "carte pokemon"]);
  });

  it("une description se mesure en octets (un accent = 2, un emoji = 4)", () => {
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😳")).toBe(4);
  });
});

describe("contrôles avant envoi", () => {
  it("rien demandé → refus", () => {
    expect(validatePatch({}, video(), NOW)).toMatch(/Rien à modifier/);
  });

  it("titre vide, trop long ou avec < >", () => {
    expect(validatePatch(normalizePatch({ title: "   " }), video(), NOW)).toMatch(/vide/);
    expect(validatePatch({ title: "x".repeat(101) }, video(), NOW)).toMatch(/101 caractères/);
    expect(validatePatch({ title: "é".repeat(100) }, video(), NOW)).toBeNull();
    expect(validatePatch({ title: "Top <3" }, video(), NOW)).toMatch(/< et >/);
  });

  it("description au-delà de 5000 octets (emojis) → refus chiffré", () => {
    expect(validatePatch({ description: "😳".repeat(1251) }, video(), NOW)).toMatch(/5004 octets/);
    expect(validatePatch({ description: "😳".repeat(1250) }, video(), NOW)).toBeNull();
  });

  it("tags au-delà de 500 caractères comptés", () => {
    const tags = Array.from({ length: 60 }, (_, i) => `tag numero ${i}`);
    expect(validatePatch({ tags }, video(), NOW)).toMatch(/Tags trop longs/);
  });

  it("date de publication : future, vidéo privée, sans autre visibilité", () => {
    const later = new Date(NOW.getTime() + 3600_000);
    expect(validatePatch({ publishAt: later }, scheduled(), NOW)).toBeNull();
    expect(validatePatch({ publishAt: new Date(NOW.getTime() + 30_000) }, scheduled(), NOW)).toMatch(/futur/);
    expect(validatePatch({ publishAt: later, privacy: "public" }, scheduled(), NOW)).toMatch(/PUBLIQUE à l'heure dite/);
    expect(validatePatch({ publishAt: later }, video(), NOW)).toMatch(/déjà en ligne/);
  });
});

describe("corps envoyé à videos.update (lecture-modification-écriture)", () => {
  it("titre seul : snippet COMPLET renvoyé (description, tags, catégorie, langues), status non envoyé", () => {
    const plan = planVideoUpdate(video(), { title: "Nouveau titre" });
    expect(plan.parts).toEqual(["snippet"]);
    expect(plan.body).toEqual({
      id: "TLL5ihkt9cI",
      snippet: {
        title: "Nouveau titre",
        description: "Le marché devient fou\n\n#pokemon #cartepokemon",
        tags: ["pokemon", "carte pokemon"],
        categoryId: "20",
        defaultLanguage: "fr",
        defaultAudioLanguage: "fr",
      },
    });
    expect(plan.changes).toEqual([{ field: "title", before: "Ils crachent sur 1 600 €", after: "Nouveau titre" }]);
  });

  it("mêmes valeurs → rien à envoyer", () => {
    const plan = planVideoUpdate(video(), { title: "Ils crachent sur 1 600 €", privacy: "public" });
    expect(plan.parts).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("visibilité : status COMPLET (intégration, licence, statistiques), jamais « made for kids »", () => {
    const plan = planVideoUpdate(video(), { privacy: "unlisted" });
    expect(plan.parts).toEqual(["status"]);
    expect(plan.body.status).toEqual({ privacyStatus: "unlisted", embeddable: true, license: "youtube", publicStatsViewable: true });
  });

  it("vidéo programmée : nouvelle date = privée + publishAt ; « public » = publication immédiate (date retirée)", () => {
    const later = new Date("2026-10-18T17:30:00Z");
    expect(planVideoUpdate(scheduled(), { publishAt: later }).body.status).toMatchObject({
      privacyStatus: "private",
      publishAt: "2026-10-18T17:30:00.000Z",
    });
    const now = planVideoUpdate(scheduled(), { privacy: "public" });
    expect(now.body.status).not.toHaveProperty("publishAt");
    expect(now.changes).toEqual([{ field: "privacy", before: "private", after: "public" }]);
  });

  it("vidéo programmée : changer le titre ne touche pas à sa programmation", () => {
    const plan = planVideoUpdate(scheduled(), { title: "Autre" });
    expect(plan.parts).toEqual(["snippet"]);
    expect(plan.body).not.toHaveProperty("status");
  });

  it("tags = [] retire tous les tags", () => {
    const plan = planVideoUpdate(video(), { tags: [] });
    expect(plan.body.snippet).not.toHaveProperty("tags");
    expect(plan.changes).toEqual([{ field: "tags", before: "pokemon, carte pokemon", after: "" }]);
  });
});

describe("erreurs de YouTube → message clair", () => {
  const google = (status: number, reason: string, message = "x") =>
    new Error(
      `Modification de la vidéo YouTube refusée (${status}): ${JSON.stringify({
        error: { code: status, message, errors: [{ reason, message }] },
      })}`
    );

  it("scope insuffisant → reconnexion pour accorder la modification", () => {
    const err = classifyVideoEditError(google(403, "insufficientPermissions", "Request had insufficient authentication scopes."));
    expect(err).toMatchObject({ code: "yt_edit_scope", reconnect: true });
    expect(err.message).toMatch(/Reconnecter/);
  });

  it("jeton révoqué, quota, contenu refusé, vidéo absente, accès interdit, serveur, réseau", () => {
    expect(classifyVideoEditError(new Error("invalid_grant: Token has been expired or revoked.")).code).toBe("yt_edit_reauth");
    expect(classifyVideoEditError(google(403, "quotaExceeded")).code).toBe("yt_edit_quota");
    expect(classifyVideoEditError(google(400, "invalidTitle")).message).toMatch(/titre/);
    expect(classifyVideoEditError(google(400, "invalidPublishAt")).message).toMatch(/jamais publiée/);
    expect(classifyVideoEditError(google(404, "videoNotFound")).code).toBe("yt_edit_not_found");
    expect(classifyVideoEditError(google(403, "forbidden", "Forbidden")).message).toMatch(/Forbidden/);
    expect(classifyVideoEditError(google(503, "backendError")).code).toBe("yt_edit_server");
    expect(classifyVideoEditError(new TypeError("fetch failed")).code).toBe("yt_edit_network");
    expect(classifyVideoEditError(google(400, "somethingNew", "Bad thing")).message).toMatch(/Bad thing/);
  });
});
