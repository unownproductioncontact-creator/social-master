import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFacebookAuthorizeUrl,
  canPublishOnPage,
  exchangeFacebookCode,
  exchangeLongLivedUserToken,
  facebookReelPublishRequested,
  fetchFacebookPermalink,
  fetchFacebookVideoStatus,
  fetchGrantedPermissions,
  fetchManagedPages,
  finishFacebookReel,
  publishFacebookPhoto,
  publishFacebookPhotos,
  publishFacebookVideoFromUrl,
  startFacebookReel,
  uploadFacebookReelFromUrl,
  waitForFacebookVideo,
} from "@/lib/providers/facebook";
import { FacebookPublishFailedError, FacebookStillProcessingError } from "@/lib/errors";

// Provider Facebook (§40) avec `fetch` SIMULÉ : aucun jeton ni réseau réel. Vérifie les URL, en-têtes et
// corps envoyés à l'API Graph, et la lecture des réponses.

type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Recorded[];

function res(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
        body: init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "",
      });
      return handler(url, init);
    })
  );
}

const form = (call: Recorded) => Object.fromEntries(new URLSearchParams(call.body));

beforeEach(() => {
  process.env.FACEBOOK_APP_ID = "fb_app";
  process.env.FACEBOOK_APP_SECRET = "fb_secret";
  delete process.env.FACEBOOK_LOGIN_CONFIG_ID;
  process.env.APP_URL = "https://social-master-jitq.onrender.com";
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connexion", () => {
  it("boîte de connexion : autorisations de Page en `scope`, ou `config_id` si une configuration est posée", () => {
    const u = new URL(buildFacebookAuthorizeUrl("st"));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("fb_app");
    expect(u.searchParams.get("redirect_uri")).toBe("https://social-master-jitq.onrender.com/api/oauth/facebook/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,pages_manage_posts");

    process.env.FACEBOOK_LOGIN_CONFIG_ID = "cfg_1";
    const withConfig = new URL(buildFacebookAuthorizeUrl("st"));
    expect(withConfig.searchParams.get("config_id")).toBe("cfg_1");
    expect(withConfig.searchParams.has("scope")).toBe(false);
  });

  it("sans identifiants de l'app : erreur claire", () => {
    delete process.env.FACEBOOK_APP_ID;
    expect(() => buildFacebookAuthorizeUrl("st")).toThrow(/FACEBOOK_APP_ID/);
  });

  it("code → jeton court → jeton long ; une erreur ne recopie jamais l'URL (secret, jeton)", async () => {
    mockFetch(() => res({ access_token: "tok", token_type: "bearer", expires_in: 5183944 }));
    await exchangeFacebookCode("the_code");
    const first = new URL(calls[0].url);
    expect(first.origin + first.pathname).toBe("https://graph.facebook.com/v25.0/oauth/access_token");
    expect(first.searchParams.get("code")).toBe("the_code");
    expect(first.searchParams.get("redirect_uri")).toBe("https://social-master-jitq.onrender.com/api/oauth/facebook/callback");
    await exchangeLongLivedUserToken("short");
    const second = new URL(calls[1].url);
    expect(second.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(second.searchParams.get("fb_exchange_token")).toBe("short");

    mockFetch(() => res({ error: { code: 100, message: "Invalid code" } }, 400));
    const err = await exchangeFacebookCode("bad").catch((e: unknown) => String(e));
    expect(err).toMatch(/oauth\/access_token a échoué \(400\)/);
    expect(err).not.toMatch(/fb_secret/);
  });

  it("Pages gérées (jeton de Page, droits, photo) et autorisations accordées", async () => {
    mockFetch((url) =>
      url.includes("/me/accounts")
        ? res({
            data: [
              { id: 61595709500373, name: "Pokemoha", access_token: "page_tok", tasks: ["CREATE_CONTENT", "MANAGE"], picture: { data: { url: "https://p/1.jpg" } } },
              { id: "2", name: "Lecture seule", access_token: "t2", tasks: ["ANALYZE"] },
              { id: "3", name: "Sans jeton" },
            ],
          })
        : res({ data: [{ permission: "pages_manage_posts", status: "granted" }, { permission: "pages_show_list", status: "declined" }] })
    );
    const pages = await fetchManagedPages("user_tok");
    expect(pages).toEqual([
      { id: "61595709500373", name: "Pokemoha", accessToken: "page_tok", tasks: ["CREATE_CONTENT", "MANAGE"], pictureUrl: "https://p/1.jpg" },
      { id: "2", name: "Lecture seule", accessToken: "t2", tasks: ["ANALYZE"], pictureUrl: undefined },
    ]);
    expect(pages.filter(canPublishOnPage).map((p) => p.name)).toEqual(["Pokemoha"]);
    expect(new URL(calls[0].url).searchParams.get("fields")).toBe("id,name,access_token,tasks,picture{url}");
    expect(await fetchGrantedPermissions("user_tok")).toEqual(["pages_manage_posts"]);
  });
});

describe("Reel", () => {
  it("1/3 réserve (jeton dans le corps), 2/3 Facebook télécharge à l'URL publique, 3/3 publie avec la légende", async () => {
    mockFetch((url) => (url.includes("rupload") ? res({ success: true }) : url.endsWith("/video_reels") && calls.length === 1 ? res({ video_id: "777", upload_url: "u" }) : res({ success: true })));
    expect(await startFacebookReel("page1", "page_tok")).toBe("777");
    expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/page1/video_reels");
    expect(calls[0].method).toBe("POST");
    expect(form(calls[0])).toEqual({ upload_phase: "start", access_token: "page_tok" });

    await uploadFacebookReelFromUrl("777", "page_tok", "https://media.example/m/short.mp4");
    expect(calls[1].url).toBe("https://rupload.facebook.com/video-upload/v25.0/777");
    expect(calls[1].headers).toEqual({ Authorization: "OAuth page_tok", file_url: "https://media.example/m/short.mp4" });

    await finishFacebookReel("page1", "page_tok", "777", "Légende\n\n#pokemon");
    expect(form(calls[2])).toEqual({
      upload_phase: "finish",
      video_id: "777",
      video_state: "PUBLISHED",
      description: "Légende\n\n#pokemon",
      access_token: "page_tok",
    });
  });

  it("envoi refusé ou non confirmé → erreur avec le code HTTP", async () => {
    mockFetch(() => res({ debug_info: { retriable: false, message: "Request processing failed" } }, 400));
    await expect(uploadFacebookReelFromUrl("777", "t", "https://m/x.mp4")).rejects.toThrow(/rupload 777 a échoué \(400\)/);
    mockFetch(() => res({ success: false }));
    await expect(uploadFacebookReelFromUrl("777", "t", "https://m/x.mp4")).rejects.toThrow(/rupload 777 a échoué/);
    await expect(finishFacebookReel("p", "t", "777", "d")).rejects.toThrow(/publication non confirmée/);
  });

  it("statut : phases lues, publication déjà demandée ou non", async () => {
    mockFetch(() =>
      res({
        status: {
          video_status: "processing",
          uploading_phase: { status: "complete" },
          processing_phase: { status: "in_progress" },
          publishing_phase: { status: "not_started" },
        },
      })
    );
    expect(await fetchFacebookVideoStatus("777", "t")).toEqual({
      videoStatus: "processing",
      uploading: "complete",
      processing: "in_progress",
      publishing: "not_started",
      publishStatus: undefined,
      errors: [],
    });
    expect(await facebookReelPublishRequested("777", "t")).toBe(false);
    mockFetch(() => res({ status: { video_status: "processing", publishing_phase: { status: "in_progress" } } }));
    expect(await facebookReelPublishRequested("777", "t")).toBe(true);
  });

  it("attente : en ligne / abandon expliqué / délai dépassé sans republication", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return res({ status: { video_status: n < 2 ? "processing" : "ready", publishing_phase: { status: n < 2 ? "in_progress" : "complete" } } });
    });
    await waitForFacebookVideo("777", "t", "reel", { intervalMs: 1, timeoutMs: 1000 });
    expect(n).toBe(2);

    mockFetch(() => res({ status: { video_status: "error", processing_phase: { status: "error", errors: [{ code: 1363040, message: "Aspect ratio" }] } } }));
    const failed = await waitForFacebookVideo("777", "t", "reel", { intervalMs: 1, timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FacebookPublishFailedError);
    expect(String(failed)).toMatch(/Aspect ratio/);

    mockFetch(() => res({ status: { video_status: "processing", publishing_phase: { status: "in_progress" } } }));
    await expect(waitForFacebookVideo("777", "t", "reel", { intervalMs: 5, timeoutMs: 12 })).rejects.toBeInstanceOf(
      FacebookStillProcessingError
    );
  });
});

describe("vidéo classique, photos, lien", () => {
  it("vidéo classique : hôte vidéo de l'API, envoi par URL et publication en un appel", async () => {
    mockFetch(() => res({ id: "888" }));
    expect(await publishFacebookVideoFromUrl("page1", "t", "https://m/long.mp4", "desc")).toBe("888");
    expect(calls[0].url).toBe("https://graph-video.facebook.com/v25.0/page1/videos");
    expect(form(calls[0])).toEqual({ file_url: "https://m/long.mp4", description: "desc", published: "true", access_token: "t" });
  });

  it("photo seule publiée tout de suite → photo + publication", async () => {
    mockFetch(() => res({ id: "p1", post_id: "page1_99" }));
    expect(await publishFacebookPhoto("page1", "t", "https://m/a.jpg", "légende")).toEqual({ photoId: "p1", postId: "page1_99" });
    expect(form(calls[0])).toEqual({ url: "https://m/a.jpg", caption: "légende", published: "true", access_token: "t" });
  });

  it("plusieurs photos : envoyées non publiées puis rassemblées dans UNE publication", async () => {
    let photo = 0;
    mockFetch((url) => (url.endsWith("/photos") ? res({ id: `ph${++photo}` }) : res({ id: "page1_42" })));
    expect(await publishFacebookPhotos("page1", "t", ["https://m/a.jpg", "https://m/b.jpg"], "légende")).toBe("page1_42");
    expect(form(calls[0])).toEqual({ url: "https://m/a.jpg", published: "false", access_token: "t" });
    expect(calls[2].url).toBe("https://graph.facebook.com/v25.0/page1/feed");
    expect(form(calls[2])).toEqual({
      message: "légende",
      access_token: "t",
      "attached_media[0]": '{"media_fbid":"ph1"}',
      "attached_media[1]": '{"media_fbid":"ph2"}',
    });
  });

  it("lien public : absolu tel quel, relatif complété, absent → null", async () => {
    mockFetch(() => res({ permalink_url: "/reel/777/" }));
    expect(await fetchFacebookPermalink("777", "t")).toBe("https://www.facebook.com/reel/777/");
    mockFetch(() => res({ permalink_url: "https://www.facebook.com/Pokemoha/posts/1" }));
    expect(await fetchFacebookPermalink("page1_1", "t")).toBe("https://www.facebook.com/Pokemoha/posts/1");
    mockFetch(() => res({}));
    expect(await fetchFacebookPermalink("x", "t")).toBeNull();
  });
});
