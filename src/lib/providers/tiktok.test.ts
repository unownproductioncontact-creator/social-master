import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/storage", () => ({ getObjectStream: vi.fn(), headObject: vi.fn() }));

import { getObjectStream, headObject } from "@/lib/storage";
import { buildTikTokAuthorizeUrl, planTikTokChunks, startTikTokDraftVideo, waitForTikTokInbox } from "@/lib/providers/tiktok";
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
    const fetchMock = stubStatuses(status("PROCESSING_UPLOAD"), status("SEND_TO_USER_INBOX", { uploaded_bytes: 54_060_311 }));
    await expect(waitForTikTokInbox("tok", "pub_1", 1, 1000)).resolves.toEqual({ uploadedBytes: 54_060_311 });
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

const MiB = 1024 * 1024;
const MAX_CHUNK = 64_000_000; // lecture la plus stricte de « 64 MB » (doc TikTok)

// Vérifie qu'un plan respecte TOUTES les règles de la doc « Media Transfer Guide » : chunk_size entre
// 5 et 64 Mo, total_chunk_count = plancher(taille / chunk_size), plusieurs chunks au-delà de 64 Mo,
// segments jointifs couvrant tout le fichier, dernier chunk ≥ chunk_size et < 128 Mo, ≤ 1000 chunks.
function assertTikTokValid(totalSize: number) {
  const { chunkSize, ranges } = planTikTokChunks(totalSize);

  expect(ranges[0].start).toBe(0);
  expect(ranges[ranges.length - 1].end).toBe(totalSize - 1);
  for (let i = 1; i < ranges.length; i++) {
    expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
  }

  expect(ranges.length).toBe(Math.floor(totalSize / chunkSize));
  expect(ranges.length).toBeLessThanOrEqual(1000);
  if (totalSize <= MAX_CHUNK) {
    expect(chunkSize).toBe(totalSize);
    expect(ranges).toHaveLength(1);
  } else {
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(chunkSize).toBeLessThanOrEqual(MAX_CHUNK);
    expect(chunkSize).toBeGreaterThanOrEqual(5 * MiB);
  }
  for (let i = 0; i < ranges.length - 1; i++) {
    expect(ranges[i].end - ranges[i].start + 1).toBe(chunkSize);
  }
  const lastSize = ranges[ranges.length - 1].end - ranges[ranges.length - 1].start + 1;
  expect(lastSize).toBeLessThan(128_000_000);
  if (ranges.length > 1) expect(lastSize).toBeGreaterThanOrEqual(chunkSize);

  return { chunkSize, ranges };
}

describe("planTikTokChunks", () => {
  it("fichier de moins de 5 Mo : envoyé en entier, chunk_size = sa taille", () => {
    expect(planTikTokChunks(1 * MiB)).toEqual({ chunkSize: 1 * MiB, ranges: [{ start: 0, end: 1 * MiB - 1 }] });
  });

  it("fichier jusqu'à 64 Mo : un seul chunk (ex. la copie TikTok de 54 Mo du 01/10/2026)", () => {
    assertTikTokValid(54_060_311);
    expect(planTikTokChunks(MAX_CHUNK).ranges).toHaveLength(1);
  });

  // Régression du 01/10/2026 : 106 Mo envoyés en UN chunk (chunk_size 64 Mio) → invalid_param.
  it("fichier de 106 Mo (la vidéo réelle) = 2 chunks, jamais un seul", () => {
    const { chunkSize, ranges } = assertTikTokValid(106_102_057);
    expect(chunkSize).toBe(53_051_028);
    expect(ranges).toEqual([
      { start: 0, end: 53_051_027 },
      { start: 53_051_028, end: 106_102_056 },
    ]);
  });

  it("juste au-dessus de 64 Mo (y compris 64 Mio pile) : déjà plusieurs chunks", () => {
    expect(assertTikTokValid(MAX_CHUNK + 1).ranges).toHaveLength(2);
    expect(assertTikTokValid(64 * MiB).ranges).toHaveLength(2);
  });

  // Régression du 09/07/2026 : « 64 Mo + reste » annonçait 2 chunks quand plancher() en donnait 1.
  it("le nombre de chunks annoncé est toujours plancher(taille / chunk_size)", () => {
    expect(assertTikTokValid(100 * MiB).ranges).toHaveLength(2);
    expect(assertTikTokValid(128_000_000).ranges).toHaveLength(2);
    expect(assertTikTokValid(200 * MiB).ranges).toHaveLength(3);
  });

  it("respecte le modèle TikTok pour un balayage de tailles de 1 à 400 Mo", () => {
    for (let size = 1 * MiB; size <= 400 * MiB; size += 3 * MiB + 12_345) {
      assertTikTokValid(size);
    }
  });

  it("reste sous la limite de 1000 chunks pour un fichier de 4 Go", () => {
    assertTikTokValid(4 * 1024 * MiB);
  });
});

describe("startTikTokDraftVideo", () => {
  const stored = new Uint8Array(106_102_057);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getObjectStream).mockReset();
    vi.mocked(headObject).mockReset();
  });

  function stubR2(sizeBytes: number) {
    vi.mocked(headObject).mockResolvedValue({ outcome: "found", sizeBytes });
    vi.mocked(getObjectStream).mockImplementation(async (_key: string, range?: string) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range ?? "")!;
      const length = Number(b) - Number(a) + 1;
      return {
        ContentLength: length,
        Body: { transformToWebStream: () => new Blob([stored.subarray(0, length)]).stream() },
      } as never;
    });
  }

  function stubTikTok(chunkStatuses: number[]) {
    type FetchInit = RequestInit & { headers: Record<string, string>; body: string };
    const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<Response>>(async (url) => {
      if (url.includes("/inbox/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub_ok", upload_url: "https://upload.test/u" }, error: { code: "ok" } }));
      }
      return new Response("", { status: chunkStatuses.shift() ?? 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("déclare le bon découpage puis envoie chaque chunk avec Content-Length et Content-Range", async () => {
    stubR2(106_102_057);
    const fetchMock = stubTikTok([206, 201]);

    await expect(startTikTokDraftVideo("tok", "media/u/v.mp4", 106_102_057, "video/quicktime")).resolves.toBe("pub_ok");

    const init = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 106_102_057, chunk_size: 53_051_028, total_chunk_count: 2 });
    const puts = fetchMock.mock.calls.slice(1).map((c) => c[1].headers);
    expect(puts).toEqual([
      { "Content-Type": "video/quicktime", "Content-Length": "53051028", "Content-Range": "bytes 0-53051027/106102057" },
      { "Content-Type": "video/quicktime", "Content-Length": "53051029", "Content-Range": "bytes 53051028-106102056/106102057" },
    ]);
  });

  it("la taille réelle du fichier stocké fait foi (jamais une vidéo tronquée si la base est fausse)", async () => {
    stubR2(54_060_311);
    const fetchMock = stubTikTok([201]);

    await startTikTokDraftVideo("tok", "media/u/v.mp4", 50_000_000);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).source_info.video_size).toBe(54_060_311);
    expect(fetchMock.mock.calls[1][1].headers["Content-Range"]).toBe("bytes 0-54060310/54060311");
  });

  it("TikTok attend encore des octets après le dernier chunk (206) → erreur, pas de brouillon incomplet", async () => {
    stubR2(54_060_311);
    stubTikTok([206]);
    await expect(startTikTokDraftVideo("tok", "media/u/v.mp4", 54_060_311)).rejects.toThrow("vidéo complète");
  });

  it("chunk refusé par TikTok → erreur avec le code HTTP", async () => {
    stubR2(54_060_311);
    stubTikTok([400]);
    await expect(startTikTokDraftVideo("tok", "media/u/v.mp4", 54_060_311)).rejects.toThrow("(400)");
  });
});
