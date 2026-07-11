import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Streaming R2 mocké : aucune connexion R2 réelle. Le corps streamé n'est jamais consommé (fetch lui-même
// est mocké), on fournit juste un Body avec transformToWebStream(). `vi.mock` est hissé au-dessus des imports.
vi.mock("@/lib/storage", () => ({
  getObjectStream: vi.fn(async () => ({ Body: { transformToWebStream: () => new ReadableStream() } })),
}));

import {
  buildYouTubeAuthorizeUrl,
  exchangeYouTubeCode,
  refreshYouTubeAccessToken,
  fetchYouTubeChannel,
  publishYouTubeShort,
} from "@/lib/providers/youtube";
import { resolveYouTubeTitle, youtubeTitleFallback } from "@/lib/content-type";
import { getObjectStream } from "@/lib/storage";

// Tests du provider YouTube avec `fetch` MOCKÉ (aucun token/réseau/R2 réel). Exercent le flux qui ne
// pourra tourner en vrai qu'une fois GOOGLE_CLIENT_ID/SECRET posés : OAuth (URL, échange, refresh),
// lecture de chaîne, et la séquence de publication resumable (init → Location → PUT streamé → id/URL).

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Recorded[];

function res(
  body: unknown,
  init?: { ok?: boolean; status?: number; headers?: Record<string, string> }
): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: new Headers(init?.headers ?? {}),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) for (const k of Object.keys(h)) headers[k] = h[k];
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        // Le corps est soit une chaîne JSON (init resumable), soit des URLSearchParams (OAuth).
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : undefined,
      });
      return handler(url, init);
    })
  );
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "gci";
  process.env.GOOGLE_CLIENT_SECRET = "gcs";
  process.env.APP_URL = "https://social-master-jitq.onrender.com";
  calls = [];
  vi.mocked(getObjectStream).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth / chaîne", () => {
  it("URL d'autorisation : scopes séparés par ESPACES, offline + prompt=consent, redirect_uri", () => {
    const u = new URL(buildYouTubeAuthorizeUrl("stateXYZ"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("gci");
    expect(u.searchParams.get("response_type")).toBe("code");
    // Google veut les scopes séparés par des espaces (≠ TikTok/Instagram en virgules).
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    expect(u.searchParams.get("state")).toBe("stateXYZ");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://social-master-jitq.onrender.com/api/oauth/youtube/callback"
    );
  });

  it("échange de code : POST grant_type=authorization_code sur le token endpoint", async () => {
    mockFetch(() =>
      res({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "s", token_type: "Bearer" })
    );
    const t = await exchangeYouTubeCode("code123");
    expect(t.access_token).toBe("at");
    expect(t.refresh_token).toBe("rt");

    const call = calls[0];
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.method).toBe("POST");
    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code123");
    expect(params.get("client_id")).toBe("gci");
    expect(params.get("client_secret")).toBe("gcs");
    expect(params.get("redirect_uri")).toBe(
      "https://social-master-jitq.onrender.com/api/oauth/youtube/callback"
    );
  });

  it("refresh : POST grant_type=refresh_token (Google ne fait PAS tourner le refresh token)", async () => {
    mockFetch(() => res({ access_token: "fresh", expires_in: 3599, scope: "s", token_type: "Bearer" }));
    const t = await refreshYouTubeAccessToken("my-refresh");
    expect(t.access_token).toBe("fresh");
    expect(t.refresh_token).toBeUndefined();

    const call = calls[0];
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("my-refresh");
  });

  it("channels.list mine=true : renvoie id, titre et miniature", async () => {
    mockFetch(() =>
      res({
        items: [
          {
            id: "UC_channel_123",
            snippet: { title: "Ma Chaîne", thumbnails: { default: { url: "https://yt/av.jpg" } } },
          },
        ],
      })
    );
    const ch = await fetchYouTubeChannel("token");
    expect(ch.id).toBe("UC_channel_123");
    expect(ch.title).toBe("Ma Chaîne");
    expect(ch.thumbnailUrl).toBe("https://yt/av.jpg");

    const call = calls[0];
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("mine")).toBe("true");
    expect(call.headers.Authorization).toBe("Bearer token");
  });

  it("compte Google sans chaîne (items vide) → lève youtubeSignupRequired", async () => {
    mockFetch(() => res({ items: [] }));
    await expect(fetchYouTubeChannel("token")).rejects.toThrow(/youtubeSignupRequired/);
  });
});

describe("Publication d'un Short (resumable)", () => {
  it("init (Location) → PUT streamé depuis R2 → id + URL /shorts/", async () => {
    const sessionUrl =
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=ABC";
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("uploadType=resumable")) {
        return res({}, { headers: { location: sessionUrl } });
      }
      if (method === "PUT") {
        return res({ id: "vid_123", status: { uploadStatus: "uploaded" } });
      }
      return res({}, { ok: false, status: 500 });
    });

    const r = await publishYouTubeShort({
      accessToken: "at",
      storageKey: "media/u/clip.mp4",
      videoSizeBytes: 1000,
      title: "Mon Short",
      description: "desc\n\n#a #b",
      contentType: "video/mp4",
    });

    expect(r.platformPostId).toBe("vid_123");
    expect(r.platformPostUrl).toBe("https://www.youtube.com/shorts/vid_123");

    // 1) init : query params, headers X-Upload-Content-*, body snippet + status (public, kids=false).
    const init = calls.find((c) => c.method === "POST")!;
    const initUrl = new URL(init.url);
    expect(initUrl.origin + initUrl.pathname).toBe("https://www.googleapis.com/upload/youtube/v3/videos");
    expect(initUrl.searchParams.get("uploadType")).toBe("resumable");
    expect(initUrl.searchParams.get("part")).toBe("snippet,status");
    expect(init.headers["X-Upload-Content-Length"]).toBe("1000");
    expect(init.headers["X-Upload-Content-Type"]).toBe("video/mp4");
    expect(init.headers.Authorization).toBe("Bearer at");
    const initBody = JSON.parse(init.body!);
    expect(initBody.snippet.title).toBe("Mon Short");
    // La description reprend EXACTEMENT le `caption` composé par le worker (légende + hashtags).
    expect(initBody.snippet.description).toBe("desc\n\n#a #b");
    expect(initBody.status.privacyStatus).toBe("public");
    expect(initBody.status.selfDeclaredMadeForKids).toBe(false);

    // 2) PUT vers l'URL de session : Content-Range couvrant tout le fichier, binaire streamé depuis R2.
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(sessionUrl);
    expect(put.headers["Content-Range"]).toBe("bytes 0-999/1000");
    expect(put.headers["Content-Length"]).toBe("1000");
    expect(vi.mocked(getObjectStream)).toHaveBeenCalledWith("media/u/clip.mp4");
  });

  it("tronque défensivement titre (≤100) et description (≤5000) ; MIME fallback video/*", async () => {
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return res({}, { headers: { location: "https://upload.session/abc" } });
      return res({ id: "v" });
    });

    await publishYouTubeShort({
      accessToken: "at",
      storageKey: "k",
      videoSizeBytes: 10,
      title: "T".repeat(150),
      description: "D".repeat(6000),
      // contentType omis → fallback video/*
    });

    const init = calls.find((c) => c.method === "POST")!;
    expect(init.headers["X-Upload-Content-Type"]).toBe("video/*");
    const initBody = JSON.parse(init.body!);
    expect(initBody.snippet.title).toHaveLength(100);
    expect(initBody.snippet.description).toHaveLength(5000);
  });

  it("échec d'init (403 quota) : propage le corps d'erreur brut (classifiable en aval)", async () => {
    mockFetch(() =>
      res(
        { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }], status: "PERMISSION_DENIED" } },
        { ok: false, status: 403 }
      )
    );
    await expect(
      publishYouTubeShort({ accessToken: "at", storageKey: "k", videoSizeBytes: 10, title: "t", description: "d" })
    ).rejects.toThrow(/quotaExceeded/);
  });

  it("init sans header Location → erreur explicite (pas d'upload à l'aveugle)", async () => {
    mockFetch(() => res({}, { headers: {} }));
    await expect(
      publishYouTubeShort({ accessToken: "at", storageKey: "k", videoSizeBytes: 10, title: "t", description: "d" })
    ).rejects.toThrow(/Location/);
  });
});

describe("titre YouTube — helpers canoniques de @/lib/content-type (contrat partagé UI/worker)", () => {
  it("youtubeTitleFallback : première ligne de la légende, coupée à 100 caractères", () => {
    expect(youtubeTitleFallback("Titre génial\nligne 2\n#tag")).toBe("Titre génial");
    expect(youtubeTitleFallback("X".repeat(200))).toHaveLength(100);
  });

  it("resolveYouTubeTitle : titre explicite prioritaire, sinon repli légende, sinon 'Short' (jamais vide)", () => {
    expect(resolveYouTubeTitle("  Mon titre  ", "légende")).toBe("Mon titre");
    expect(resolveYouTubeTitle(undefined, "Première ligne\n#tags")).toBe("Première ligne");
    expect(resolveYouTubeTitle("", "")).toBe("Short");
    expect(resolveYouTubeTitle(null, "   \n  ")).toBe("Short");
  });
});
