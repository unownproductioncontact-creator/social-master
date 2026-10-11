import { describe, expect, it } from "vitest";
import { describeDelivery, mediaUrlDelivery, readDelivery, tiktokVideoDelivery, youtubeDelivery } from "./delivery-path";

describe("chemin de livraison d'une publication", () => {
  it("Instagram / photos TikTok : URL du Worker si configuré, sinon /api/m/ de Render", () => {
    expect(mediaUrlDelivery(true)).toEqual({ via: "worker", method: "media_url" });
    expect(mediaUrlDelivery(false)).toEqual({ via: "render", method: "media_url" });
  });

  it("vidéo TikTok : PULL_FROM_URL par le Worker, sinon envoi par morceaux depuis Render", () => {
    expect(tiktokVideoDelivery(true)).toEqual({ via: "worker", method: "pull_from_url" });
    expect(tiktokVideoDelivery(false)).toEqual({ via: "render", method: "file_upload" });
  });

  it("YouTube : poussé par le Worker si MEDIA_PUSH_SECRET est posé, sinon diffusé par Render", () => {
    expect(youtubeDelivery(true)).toEqual({ via: "worker", method: "worker_push" });
    expect(youtubeDelivery(false)).toEqual({ via: "render", method: "render_stream" });
  });

  it("relit le détail d'une entrée du journal, et ignore tout ce qui est absent ou malformé", () => {
    expect(readDelivery({ postId: "p", delivery: { via: "worker", method: "worker_push" } })).toEqual({
      via: "worker",
      method: "worker_push",
    });
    for (const bad of [null, undefined, "x", {}, { delivery: null }, { delivery: { via: "ailleurs", method: "media_url" } }, { delivery: { via: "worker", method: "inconnue" } }]) {
      expect(readDelivery(bad)).toBeNull();
    }
  });

  it("phrase lisible : dit clairement si la sortie est facturée", () => {
    expect(describeDelivery({ via: "worker", method: "worker_push" })).toBe("Worker Cloudflare — le Worker a poussé le fichier depuis R2");
    expect(describeDelivery({ via: "render", method: "media_url" })).toContain("Render (sortie facturée");
  });
});
