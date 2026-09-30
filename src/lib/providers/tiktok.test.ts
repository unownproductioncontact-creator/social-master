import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTikTokAuthorizeUrl, computeChunkRanges, waitForTikTokInbox } from "@/lib/providers/tiktok";
import { TikTokPublishFailedError, TikTokStillProcessingError } from "@/lib/errors";

describe("waitForTikTokInbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Réponses successives de /status/fetch/ au format TikTok { data, error }.
  function stubStatuses(...bodies: unknown[]) {
    const fetchMock = vi.fn();
    for (const body of bodies) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    }
    // Réponse neuve à chaque appel : un corps de Response ne se lit qu'une fois.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const status = (s: string, extra: object = {}) => ({ data: { status: s, ...extra }, error: { code: "ok" } });

  it("résout dès que TikTok a déposé le brouillon dans la boîte de réception", async () => {
    const fetchMock = stubStatuses(status("PROCESSING_UPLOAD"), status("SEND_TO_USER_INBOX"));
    await expect(waitForTikTokInbox("tok", "pub_1", 1, 1000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ publish_id: "pub_1" });
  });

  it("toujours en traitement après le délai → TikTokStillProcessingError (pas un échec)", async () => {
    stubStatuses();
    const err = await waitForTikTokInbox("tok", "pub_lent", 1, 20).catch((e) => e);
    expect(err).toBeInstanceOf(TikTokStillProcessingError);
    expect(err.publishId).toBe("pub_lent");
  });

  it("statut FAILED → TikTokPublishFailedError avec la fail_reason", async () => {
    stubStatuses(status("FAILED", { fail_reason: "duration_check_failed" }));
    const err = await waitForTikTokInbox("tok", "pub_2", 1, 1000).catch((e) => e);
    expect(err).toBeInstanceOf(TikTokPublishFailedError);
    expect(err.failReason).toBe("duration_check_failed");
  });

  it("statut absent ou inconnu : jamais pris pour un succès, on continue d'attendre", async () => {
    stubStatuses({ data: {}, error: { code: "ok" } }, status("QUELQUE_CHOSE"));
    await expect(waitForTikTokInbox("tok", "pub_3", 1, 20)).rejects.toBeInstanceOf(TikTokStillProcessingError);
  });

  it("réponse d'erreur TikTok (error.code ≠ ok) → erreur explicite", async () => {
    stubStatuses({ data: {}, error: { code: "invalid_publish_id", message: "publish_id does not exist" } });
    await expect(waitForTikTokInbox("tok", "pub_4", 1, 1000)).rejects.toThrow("invalid_publish_id");
  });
});

describe("buildTikTokAuthorizeUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("force l'affichage de la page d'autorisation et transmet les paramètres OAuth", () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "ck_test");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "cs_test");
    vi.stubEnv("APP_URL", "https://example.test/");

    const url = new URL(buildTikTokAuthorizeUrl("etat-123"));

    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
    expect(url.searchParams.get("client_key")).toBe("ck_test");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.upload");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/api/oauth/tiktok/callback");
    expect(url.searchParams.get("state")).toBe("etat-123");
  });
});

const MB = 1024 * 1024;
const MAX_CHUNK = 64 * MB;

// Reproduit la contrainte que le worker déclare à TikTok et vérifie qu'elle respecte le modèle
// officiel : chunk_size ∈ [.., 64 Mo], total_chunk_count = plancher(taille / chunk_size), segments
// jointifs couvrant tout le fichier, dernier chunk < 128 Mo. Tout écart = `invalid_param` côté TikTok.
function assertTikTokValid(totalSize: number) {
  const ranges = computeChunkRanges(totalSize);

  // Couverture exacte de [0, totalSize) sans trou ni chevauchement.
  expect(ranges[0].start).toBe(0);
  expect(ranges[ranges.length - 1].end).toBe(totalSize - 1);
  for (let i = 1; i < ranges.length; i++) {
    expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
  }

  // total_chunk_count attendu par TikTok = plancher(taille / chunk_size).
  const chunkSize = totalSize <= MAX_CHUNK ? totalSize : MAX_CHUNK;
  const expectedCount = totalSize <= MAX_CHUNK ? 1 : Math.floor(totalSize / MAX_CHUNK);
  expect(ranges.length).toBe(expectedCount);

  // Les (count - 1) premiers chunks font exactement chunk_size ; le dernier absorbe le reste (< 128 Mo).
  for (let i = 0; i < ranges.length - 1; i++) {
    expect(ranges[i].end - ranges[i].start + 1).toBe(chunkSize);
  }
  const lastSize = ranges[ranges.length - 1].end - ranges[ranges.length - 1].start + 1;
  expect(lastSize).toBeLessThan(128 * MB);
  if (ranges.length > 1) expect(lastSize).toBeGreaterThanOrEqual(chunkSize);

  return ranges;
}

describe("computeChunkRanges", () => {
  it("tient en un seul chunk pour un fichier sous 64 Mo", () => {
    expect(computeChunkRanges(3 * MB)).toEqual([{ start: 0, end: 3 * MB - 1 }]);
  });

  it("tient en un seul chunk pour un fichier de moins de 5 Mo", () => {
    const ranges = computeChunkRanges(1 * MB);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].end - ranges[0].start + 1).toBe(1 * MB);
  });

  it("un fichier de 64 Mo pile tient en un seul chunk", () => {
    expect(computeChunkRanges(MAX_CHUNK)).toEqual([{ start: 0, end: MAX_CHUNK - 1 }]);
  });

  // Régression du bug du 09/07/2026 : plancher(100/64) = 1, l'ancien code produisait 2 chunks →
  // total_chunk_count=2 refusé par TikTok (`invalid_param`) sur toutes les vidéos > 64 Mo « non pile ».
  it("un fichier de 100 Mo = 1 SEUL chunk (le dernier absorbe tout, pas 64 + 36)", () => {
    const ranges = assertTikTokValid(100 * MB);
    expect(ranges).toEqual([{ start: 0, end: 100 * MB - 1 }]);
  });

  it("un fichier de 130 Mo = 2 chunks (64 Mo + 66 Mo)", () => {
    const ranges = assertTikTokValid(130 * MB);
    expect(ranges).toHaveLength(2);
    expect(ranges[1].end - ranges[1].start + 1).toBe(66 * MB);
  });

  it("un fichier de 150 Mo = 2 chunks (64 Mo + 86 Mo)", () => {
    const ranges = assertTikTokValid(150 * MB);
    expect(ranges).toHaveLength(2);
  });

  it("un fichier de 200 Mo = 3 chunks (64 + 64 + 72 Mo), pas 4", () => {
    const ranges = assertTikTokValid(200 * MB);
    expect(ranges).toHaveLength(3);
    expect(ranges[2].end - ranges[2].start + 1).toBe(72 * MB);
  });

  it("respecte le modèle TikTok pour un balayage de tailles > 64 Mo", () => {
    for (let mb = 65; mb <= 400; mb += 7) {
      assertTikTokValid(mb * MB);
    }
  });

  it("reste sous la limite de 1000 chunks pour un fichier proche de 4 Go", () => {
    const totalSize = 4 * 1024 * MB - 1; // ~4 Go
    const ranges = assertTikTokValid(totalSize);
    expect(ranges.length).toBeLessThanOrEqual(1000);
  });
});
