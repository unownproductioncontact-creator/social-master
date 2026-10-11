import { describe, expect, it } from "vitest";
import { ORPHAN_MIN_AGE_MS, orphanCountLooksSafe, selectOrphanObjects } from "./orphan-sweep";
import type { BucketObject } from "./media-worker";

const NOW = new Date("2026-11-01T07:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function object(key: string, ageDays: number, size = 1000): BucketObject {
  return { key, size, uploaded: new Date(NOW.getTime() - ageDays * DAY).toISOString() };
}

describe("selectOrphanObjects", () => {
  it("garde tout ce que la base référence, supprime le reste quand c'est assez ancien", () => {
    const referenced = new Set(["media/u/a.mp4", "media/u/a.mp4.thumb.jpg"]);
    const result = selectOrphanObjects(
      [object("media/u/a.mp4", 90), object("media/u/a.mp4.thumb.jpg", 90), object("media/u/old.mp4.thumb.jpg", 90, 12_000)],
      referenced,
      NOW
    );
    expect(result.orphans.map((o) => o.key)).toEqual(["media/u/old.mp4.thumb.jpg"]);
    expect(result.orphanBytes).toBe(12_000);
    expect(result.inspected).toBe(3);
  });

  it("n'efface jamais un objet de moins de 7 jours (envoi ou import peut-être en cours)", () => {
    const result = selectOrphanObjects([object("media/u/new.mp4", 6.9), object("media/u/edge.mp4", 7)], new Set(), NOW);
    expect(result.orphans.map((o) => o.key)).toEqual(["media/u/edge.mp4"]);
    expect(result.tooRecent).toBe(1);
    expect(ORPHAN_MIN_AGE_MS).toBe(7 * DAY);
  });

  it("date illisible ou absente = âge inconnu : on n'y touche pas", () => {
    const result = selectOrphanObjects(
      [{ key: "media/u/x.mp4", size: 1, uploaded: null }, { key: "media/u/y.mp4", size: 1, uploaded: "pas une date" }],
      new Set(),
      NOW
    );
    expect(result.orphans).toEqual([]);
    expect(result.tooRecent).toBe(2);
  });

  it("ne regarde que le préfixe media/ : jamais un objet posé ailleurs", () => {
    const result = selectOrphanObjects([object("autre/x.bin", 90), object("_selftest/y.bin", 90), object("media/u/z.mp4", 90)], new Set(), NOW);
    expect(result.orphans.map((o) => o.key)).toEqual(["media/u/z.mp4"]);
    expect(result.inspected).toBe(1);
  });

  it("plafonne le nombre de suppressions, les plus anciens d'abord, et signale le total éligible", () => {
    const objects = [object("media/u/c.mp4", 10), object("media/u/a.mp4", 300), object("media/u/b.mp4", 100)];
    const result = selectOrphanObjects(objects, new Set(), NOW, { max: 2 });
    expect(result.orphans.map((o) => o.key)).toEqual(["media/u/a.mp4", "media/u/b.mp4"]);
    expect(result.eligible).toBe(3);
  });
});

describe("orphanCountLooksSafe", () => {
  it("quelques orphelins sont toujours normaux, même si c'est la majorité d'un petit bucket", () => {
    expect(orphanCountLooksSafe(0, 18)).toBe(true);
    expect(orphanCountLooksSafe(5, 18)).toBe(true);
    expect(orphanCountLooksSafe(10, 12)).toBe(true);
  });

  it("au-delà d'une dizaine, plus de la moitié du bucket = anormal (base mal branchée, listing tronqué)", () => {
    expect(orphanCountLooksSafe(11, 20)).toBe(false);
    expect(orphanCountLooksSafe(50, 100)).toBe(true);
    expect(orphanCountLooksSafe(51, 100)).toBe(false);
  });
});
