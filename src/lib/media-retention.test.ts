import { describe, it, expect } from "vitest";
import {
  daysBeforeUnusedPurge,
  selectPurgeableMedia,
  selectUnusedStaleMedia,
  UNUSED_MEDIA_MAX_AGE_DAYS,
  type RetentionCandidate,
} from "@/lib/media-retention";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Fabrique un candidat avec des valeurs par défaut « purgeable » qu'on surcharge au cas par cas. */
function candidate(overrides: Partial<RetentionCandidate> & { id: string }): RetentionCandidate {
  return {
    allPostsResolved: true,
    inUseByPendingPost: false,
    lastPublishedAt: new Date(NOW.getTime() - 100 * DAY),
    ...overrides,
  };
}

describe("selectPurgeableMedia", () => {
  it("purge un média dont tous les posts sont publiés et dont la publication dépasse la rétention", () => {
    const assets = [candidate({ id: "a", lastPublishedAt: new Date(NOW.getTime() - 40 * DAY) })];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual(["a"]);
  });

  it("ne purge JAMAIS un média jamais utilisé (lastPublishedAt null, non résolu)", () => {
    const assets = [
      candidate({ id: "never-used", allPostsResolved: false, lastPublishedAt: null }),
    ];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual([]);
  });

  it("ne purge pas un média utilisé par un post pas-encore-publié", () => {
    const assets = [
      // brouillon/programmé en cours : allPostsResolved faux + inUseByPendingPost vrai
      candidate({ id: "pending", allPostsResolved: false, inUseByPendingPost: true }),
    ];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual([]);
  });

  it("ne purge pas si la dernière publication est plus récente que la rétention", () => {
    const assets = [candidate({ id: "recent", lastPublishedAt: new Date(NOW.getTime() - 10 * DAY) })];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual([]);
  });

  it("frontière stricte : exactement à la limite n'est PAS purgé, une milliseconde au-delà l'est", () => {
    const atCutoff = candidate({ id: "at", lastPublishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const justOver = candidate({ id: "over", lastPublishedAt: new Date(NOW.getTime() - 30 * DAY - 1) });
    expect(selectPurgeableMedia([atCutoff], 30, NOW)).toEqual([]);
    expect(selectPurgeableMedia([justOver], 30, NOW)).toEqual(["over"]);
  });

  it("défensif : allPostsResolved vrai mais lastPublishedAt null → pas purgé", () => {
    const assets = [candidate({ id: "weird", allPostsResolved: true, lastPublishedAt: null })];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual([]);
  });

  it("défensif : contradiction allPostsResolved vrai + inUseByPendingPost vrai → pas purgé", () => {
    const assets = [candidate({ id: "contradiction", inUseByPendingPost: true })];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual([]);
  });

  it("une rétention négative ou non finie ne purge rien (garde-fou)", () => {
    const assets = [candidate({ id: "a" })];
    expect(selectPurgeableMedia(assets, -7, NOW)).toEqual([]);
    expect(selectPurgeableMedia(assets, Number.NaN, NOW)).toEqual([]);
  });

  it("mode « Dès la publication » (0) : purge tout média entièrement publié, mais garde les mêmes garde-fous", () => {
    const assets = [
      candidate({ id: "published-old", lastPublishedAt: new Date(NOW.getTime() - 100 * DAY) }),
      candidate({ id: "published-1s-ago", lastPublishedAt: new Date(NOW.getTime() - 1000) }),
      candidate({ id: "pending", allPostsResolved: false, inUseByPendingPost: true }),
      candidate({ id: "unused", allPostsResolved: false, lastPublishedAt: null }),
    ];
    // Les publiés partent (cutoff = now), le brouillon et le jamais-utilisé sont conservés.
    expect(selectPurgeableMedia(assets, 0, NOW)).toEqual(["published-old", "published-1s-ago"]);
  });

  it("respecte les différents paliers de rétention (7 / 30 / 90 jours)", () => {
    const publishedDaysAgo = (d: number) =>
      candidate({ id: `p${d}`, lastPublishedAt: new Date(NOW.getTime() - d * DAY) });
    const assets = [publishedDaysAgo(8), publishedDaysAgo(31), publishedDaysAgo(95)];

    expect(selectPurgeableMedia(assets, 7, NOW)).toEqual(["p8", "p31", "p95"]);
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual(["p31", "p95"]);
    expect(selectPurgeableMedia(assets, 90, NOW)).toEqual(["p95"]);
  });

  it("filtre un mélange en ne retournant que les identifiants purgeables, dans l'ordre", () => {
    const assets = [
      candidate({ id: "keep-recent", lastPublishedAt: new Date(NOW.getTime() - 5 * DAY) }),
      candidate({ id: "purge-1", lastPublishedAt: new Date(NOW.getTime() - 60 * DAY) }),
      candidate({ id: "keep-draft", allPostsResolved: false, inUseByPendingPost: true }),
      candidate({ id: "keep-unused", allPostsResolved: false, lastPublishedAt: null }),
      candidate({ id: "purge-2", lastPublishedAt: new Date(NOW.getTime() - 45 * DAY) }),
    ];
    expect(selectPurgeableMedia(assets, 30, NOW)).toEqual(["purge-1", "purge-2"]);
  });

  it("retourne un tableau vide sur une liste vide", () => {
    expect(selectPurgeableMedia([], 30, NOW)).toEqual([]);
  });
});

describe("selectUnusedStaleMedia (médias jamais utilisés, 30 jours)", () => {
  const unused = (id: string, ageDays: number, postCount = 0) => ({
    id,
    createdAt: new Date(NOW.getTime() - ageDays * DAY),
    postCount,
  });

  it("le délai confirmé par le user est de 30 jours", () => {
    expect(UNUSED_MEDIA_MAX_AGE_DAYS).toBe(30);
  });

  it("supprime un média sans aucun post, ajouté il y a plus de 30 jours", () => {
    expect(selectUnusedStaleMedia([unused("a", 31)], NOW)).toEqual(["a"]);
  });

  it("garde un média récent, et un média utilisé quel que soit son âge (un brouillon suffit)", () => {
    const assets = [unused("recent", 10), unused("used-old", 400, 1), unused("draft-old", 90, 2)];
    expect(selectUnusedStaleMedia(assets, NOW)).toEqual([]);
  });

  it("frontière stricte : exactement 30 jours = gardé, une milliseconde de plus = supprimé", () => {
    const atLimit = { id: "at", createdAt: new Date(NOW.getTime() - 30 * DAY), postCount: 0 };
    const over = { id: "over", createdAt: new Date(NOW.getTime() - 30 * DAY - 1), postCount: 0 };
    expect(selectUnusedStaleMedia([atLimit], NOW)).toEqual([]);
    expect(selectUnusedStaleMedia([over], NOW)).toEqual(["over"]);
  });

  it("un délai ≤ 0 ou non fini ne supprime rien (garde-fou)", () => {
    for (const days of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(selectUnusedStaleMedia([unused("a", 999)], NOW, days)).toEqual([]);
    }
  });
});

describe("daysBeforeUnusedPurge", () => {
  it("compte les jours restants, arrondis au supérieur, jamais négatifs", () => {
    expect(daysBeforeUnusedPurge(new Date(NOW.getTime() - 6 * DAY), NOW)).toBe(24);
    expect(daysBeforeUnusedPurge(new Date(NOW.getTime() - 29.5 * DAY), NOW)).toBe(1);
    expect(daysBeforeUnusedPurge(new Date(NOW.getTime() - 45 * DAY), NOW)).toBe(0);
  });
});
