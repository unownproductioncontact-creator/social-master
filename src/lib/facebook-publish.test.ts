import { describe, expect, it, vi } from "vitest";
import { FacebookPublishFailedError, FacebookStillProcessingError } from "@/lib/errors";
import {
  decideFacebookVideo,
  deliverFacebookVideo,
  readFacebookProgress,
  withFacebookProgress,
  type FacebookVideoDeps,
  type FacebookVideoProgress,
} from "@/lib/facebook-publish";

function reelDeps(existing: FacebookVideoProgress | null, overrides: Partial<FacebookVideoDeps> = {}) {
  const saved: Array<FacebookVideoProgress | null> = [];
  const deps = {
    existing,
    start: vi.fn(async () => "vid_new"),
    upload: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    alreadyPublishing: vi.fn(async () => false),
    save: vi.fn(async (p: FacebookVideoProgress | null) => {
      saved.push(p);
    }),
    waitUntilPublished: vi.fn(async () => {}),
    ...overrides,
  } satisfies FacebookVideoDeps;
  return { deps, saved };
}

describe("publication d'une vidéo Facebook sans doublon", () => {
  it("Reel neuf : réserve, envoie, note « uploaded », publie, note « finished » AVANT d'attendre", async () => {
    const order: string[] = [];
    const { deps, saved } = reelDeps(null, {
      start: vi.fn(async () => (order.push("start"), "vid_new")),
      upload: vi.fn(async () => {
        order.push("upload");
      }),
      finish: vi.fn(async () => {
        order.push("finish");
      }),
      waitUntilPublished: vi.fn(async () => {
        order.push("wait");
      }),
    });
    expect(await deliverFacebookVideo(deps)).toBe("vid_new");
    expect(order).toEqual(["start", "upload", "finish", "wait"]);
    expect(saved).toEqual([
      { videoId: "vid_new", phase: "uploaded" },
      { videoId: "vid_new", phase: "finished" },
    ]);
  });

  it("déjà publiée par une tentative précédente : on attend seulement, jamais de renvoi", async () => {
    const { deps } = reelDeps({ videoId: "vid_old", phase: "finished" });
    expect(await deliverFacebookVideo(deps)).toBe("vid_old");
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
    expect(deps.waitUntilPublished).toHaveBeenCalledWith("vid_old");
  });

  it("arrêtée entre l'envoi et la publication : publication demandée une seule fois (vérifiée chez Facebook)", async () => {
    const pending = reelDeps({ videoId: "vid_up", phase: "uploaded" });
    await deliverFacebookVideo(pending.deps);
    expect(pending.deps.alreadyPublishing).toHaveBeenCalledWith("vid_up");
    expect(pending.deps.finish).toHaveBeenCalledWith("vid_up");
    expect(pending.deps.start).not.toHaveBeenCalled();

    const done = reelDeps({ videoId: "vid_up", phase: "uploaded" }, { alreadyPublishing: vi.fn(async () => true) });
    await deliverFacebookVideo(done.deps);
    expect(done.deps.finish).not.toHaveBeenCalled();
    expect(done.saved.at(-1)).toEqual({ videoId: "vid_up", phase: "finished" });
  });

  it("encore en traitement : l'erreur remonte, l'avancement reste (le retry reprendra l'attente)", async () => {
    const { deps, saved } = reelDeps(null, {
      waitUntilPublished: vi.fn(async () => {
        throw new FacebookStillProcessingError("vid_new");
      }),
    });
    await expect(deliverFacebookVideo(deps)).rejects.toBeInstanceOf(FacebookStillProcessingError);
    expect(saved.at(-1)).toEqual({ videoId: "vid_new", phase: "finished" });
  });

  it("abandonnée par Facebook : avancement oublié, un retry repartira d'un envoi neuf", async () => {
    const { deps, saved } = reelDeps(null, {
      waitUntilPublished: vi.fn(async () => {
        throw new FacebookPublishFailedError("ratio");
      }),
    });
    await expect(deliverFacebookVideo(deps)).rejects.toBeInstanceOf(FacebookPublishFailedError);
    expect(saved.at(-1)).toBeNull();
  });

  it("vidéo classique (publiée dès l'envoi) : un seul appel, notée « finished »", async () => {
    const saved: Array<FacebookVideoProgress | null> = [];
    const start = vi.fn(async () => "vid_classic");
    const id = await deliverFacebookVideo({
      existing: null,
      start,
      save: async (p) => {
        saved.push(p);
      },
      waitUntilPublished: async () => {},
    });
    expect(id).toBe("vid_classic");
    expect(start).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([{ videoId: "vid_classic", phase: "finished" }]);
  });
});

describe("avancement noté dans les options de la cible", () => {
  it("lecture tolérante, écriture sans toucher aux autres options", () => {
    expect(readFacebookProgress(null)).toBeNull();
    expect(readFacebookProgress({ fbVideo: { videoId: "", phase: "finished" } })).toBeNull();
    expect(readFacebookProgress({ fbVideo: { videoId: "v", phase: "bizarre" } })).toBeNull();
    expect(readFacebookProgress({ fbVideo: { videoId: "v", phase: "uploaded" } })).toEqual({ videoId: "v", phase: "uploaded" });
    expect(withFacebookProgress({ other: 1 }, { videoId: "v", phase: "finished" })).toEqual({
      other: 1,
      fbVideo: { videoId: "v", phase: "finished" },
    });
    expect(withFacebookProgress({ other: 1, fbVideo: { videoId: "v" } }, null)).toEqual({ other: 1 });
  });
});

describe("statut d'une vidéo Facebook", () => {
  const base = { errors: [] as string[] };
  it("Reel : en ligne quand la phase de publication est terminée", () => {
    expect(decideFacebookVideo({ ...base, videoStatus: "ready", publishing: "complete" }, "reel")).toBe("published");
    expect(decideFacebookVideo({ ...base, videoStatus: "processing", publishing: "not_started" }, "reel")).toBe("processing");
    expect(decideFacebookVideo({ ...base, publishStatus: "published" }, "reel")).toBe("published");
  });
  it("vidéo classique : en ligne quand elle est prête ; « error » partout = abandon", () => {
    expect(decideFacebookVideo({ ...base, videoStatus: "ready" }, "video")).toBe("published");
    expect(decideFacebookVideo({ ...base, videoStatus: "processing" }, "video")).toBe("processing");
    expect(decideFacebookVideo({ ...base, videoStatus: "error" }, "video")).toBe("failed");
    expect(decideFacebookVideo({ ...base, processing: "error" }, "reel")).toBe("failed");
    expect(decideFacebookVideo({ errors: ["Aspect ratio"], videoStatus: "processing" }, "reel")).toBe("failed");
  });
});
