import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInstagramAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  fetchInstagramProfile,
  createMediaContainer,
  publishInstagramMedia,
  publishInstagramCarousel,
  getContentPublishingLimit,
} from "@/lib/providers/instagram";

// Tests du flux de publication Instagram avec `fetch` MOCKÉ (aucun token/réseau réel). Exercent le
// code qui n'avait jamais tourné (le vrai run étant bloqué faute de compte Meta) et valident les
// correctifs de l'audit du 09/07 : normalisation `permissions` CSV→tableau, déballage `data[]` de
// /me, distinction conteneur ERROR (rejet) vs délai, séquence container→poll→publish→permalink.

function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

type Call = { url: string; method: string; body?: URLSearchParams };
let calls: Call[];

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body instanceof URLSearchParams ? init.body : undefined,
      });
      return handler(url, init);
    })
  );
}

beforeEach(() => {
  process.env.META_APP_ID = "ig-app-id";
  process.env.META_APP_SECRET = "ig-app-secret";
  process.env.APP_URL = "https://social-master-jitq.onrender.com";
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth / profil", () => {
  it("URL d'autorisation : scopes CSV, redirect_uri et state corrects", () => {
    const u = new URL(buildInstagramAuthorizeUrl("state123"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("state123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://social-master-jitq.onrender.com/api/oauth/instagram/callback"
    );
  });

  it("FIX CRITIQUE : permissions renvoyées en CSV sont normalisées en tableau", async () => {
    mockFetch(() =>
      res({
        access_token: "short",
        user_id: 12345,
        permissions: "instagram_business_basic,instagram_business_content_publish",
      })
    );
    const r = await exchangeCodeForShortLivedToken("code123");
    expect(r.permissions).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
    expect(r.user_id).toBe("12345"); // toujours une chaîne, même si l'API renvoie un nombre
  });

  it("échange de code : déballe { data: [...] } et accepte permissions déjà en tableau", async () => {
    mockFetch(() => res({ data: [{ access_token: "s", user_id: "9", permissions: ["a", "b"] }] }));
    const r = await exchangeCodeForShortLivedToken("c");
    expect(r.permissions).toEqual(["a", "b"]);
    expect(r.access_token).toBe("s");
  });

  it("FIX MAJEUR : /me enveloppé dans data[] est déballé", async () => {
    mockFetch(() => res({ data: [{ user_id: "42", username: "moha", account_type: "BUSINESS" }] }));
    const p = await fetchInstagramProfile("token");
    expect(p.user_id).toBe("42");
    expect(p.username).toBe("moha");
    expect(p.account_type).toBe("BUSINESS");
  });
});

describe("Publication média unique", () => {
  it("Reel : container → poll (IN_PROGRESS→FINISHED) → publish → permalink", async () => {
    let statusCalls = 0;
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/media_publish")) return res({ id: "media_final" });
      if (method === "POST" && url.includes("/media")) return res({ id: "container_1" });
      if (url.includes("fields=status_code")) {
        statusCalls++;
        return res({ status_code: statusCalls < 2 ? "IN_PROGRESS" : "FINISHED" });
      }
      if (url.includes("fields=permalink")) return res({ permalink: "https://instagram.com/p/x" });
      return res({}, false, 500);
    });

    const r = await publishInstagramMedia(
      { igUserId: "ig", accessToken: "t", caption: "hey", mediaType: "REELS", mediaUrl: "https://m/v.mp4" },
      1, // pollIntervalMs = 1 ms pour le test
      5000
    );
    expect(r.platformPostId).toBe("media_final");
    expect(r.platformPostUrl).toBe("https://instagram.com/p/x");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    // Le container Reel porte bien media_type REELS + video_url.
    const containerPost = calls.find((c) => c.method === "POST" && c.body?.get("media_type") === "REELS");
    expect(containerPost?.body?.get("video_url")).toBe("https://m/v.mp4");
  });

  it("FIX : un conteneur en ERROR lève ig_container_error (→ rejet de contenu, pas de retry)", async () => {
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/media")) return res({ id: "c1" });
      if (url.includes("fields=status_code")) return res({ status_code: "ERROR" });
      return res({}, false, 500);
    });
    await expect(
      publishInstagramMedia(
        { igUserId: "ig", accessToken: "t", caption: "x", mediaType: "REELS", mediaUrl: "https://m/v.mp4" },
        1,
        5000
      )
    ).rejects.toThrow(/ig_container_error/);
  });

  it("FIX : une Story n'envoie PAS de caption dans son conteneur", async () => {
    mockFetch(() => res({ id: "cont1" }));
    await createMediaContainer({
      igUserId: "ig",
      accessToken: "t",
      caption: "hello #tag",
      mediaType: "STORIES",
      mediaUrl: "https://m/s.mp4",
      isVideo: true,
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body?.get("media_type")).toBe("STORIES");
    expect(post?.body?.get("caption")).toBeNull();
    expect(post?.body?.get("video_url")).toBe("https://m/s.mp4");
  });
});

describe("Carrousel", () => {
  it("enfants (is_carousel_item) → parent (CAROUSEL + children CSV) → publish", async () => {
    const posts: URLSearchParams[] = [];
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posts.push(init!.body as URLSearchParams);
        if (url.includes("/media_publish")) return res({ id: "carousel_final" });
        return res({ id: `cont_${posts.length}` });
      }
      if (url.includes("fields=status_code")) return res({ status_code: "FINISHED" });
      if (url.includes("fields=permalink")) return res({ permalink: "https://ig/c" });
      return res({}, false, 500);
    });

    const r = await publishInstagramCarousel(
      "ig",
      "t",
      "cap",
      [
        { mediaUrl: "https://m/1.jpg", isVideo: false },
        { mediaUrl: "https://m/2.mp4", isVideo: true },
      ],
      1,
      5000
    );
    expect(r.platformPostId).toBe("carousel_final");
    // Les 2 enfants portent is_carousel_item=true.
    const children = posts.filter((p) => p.get("is_carousel_item") === "true");
    expect(children).toHaveLength(2);
    // Le parent est un CAROUSEL avec une liste children (CSV de 2 IDs).
    const parent = posts.find((p) => p.get("media_type") === "CAROUSEL");
    expect(parent).toBeTruthy();
    expect(parent!.get("children")).toContain(",");
  });

  it("refuse un carrousel hors bornes 2–10", async () => {
    mockFetch(() => res({ id: "x" }));
    await expect(
      publishInstagramCarousel("ig", "t", "c", [{ mediaUrl: "u", isVideo: false }], 1, 5000)
    ).rejects.toThrow(/2 (et|à) 10|entre 2/i);
  });
});

describe("Quota", () => {
  it("lit config.quota_total, retombe sur 25 (conservateur) si config absent", async () => {
    mockFetch(() => res({ data: [{ quota_usage: 3, config: { quota_total: 50 } }] }));
    expect(await getContentPublishingLimit("ig", "t")).toEqual({ quotaUsage: 3, quotaTotal: 50 });

    mockFetch(() => res({ data: [{ quota_usage: 1 }] }));
    expect(await getContentPublishingLimit("ig", "t")).toEqual({ quotaUsage: 1, quotaTotal: 25 });
  });

  it("P2-7a : passe un AbortSignal au fetch quand un timeout est fourni (rétro-compatible sans arg)", async () => {
    let sawSignal = false;
    mockFetch((_url, init) => {
      if (init?.signal instanceof AbortSignal) sawSignal = true;
      return res({ data: [{ quota_usage: 2, config: { quota_total: 50 } }] });
    });

    // Timeout explicite (le chemin bulk passe 3000 ms) : la valeur de retour est inchangée…
    const r = await getContentPublishingLimit("ig", "t", 3000);
    expect(r).toEqual({ quotaUsage: 2, quotaTotal: 50 });
    // …et un AbortSignal a bien été fourni au fetch.
    expect(sawSignal).toBe(true);
  });
});
