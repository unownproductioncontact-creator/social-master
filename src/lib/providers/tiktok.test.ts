import { describe, it, expect } from "vitest";
import { computeChunkRanges } from "@/lib/providers/tiktok";

const MB = 1024 * 1024;

describe("computeChunkRanges", () => {
  it("tient en un seul chunk pour un fichier sous 64 Mo", () => {
    const ranges = computeChunkRanges(3 * MB);
    expect(ranges).toEqual([{ start: 0, end: 3 * MB - 1 }]);
  });

  it("tient en un seul chunk pour un fichier de moins de 5 Mo", () => {
    const ranges = computeChunkRanges(1 * MB);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].end - ranges[0].start + 1).toBe(1 * MB);
  });

  it("découpe en chunks de 64 Mo pour un fichier de 150 Mo, dernier chunk = reste", () => {
    const totalSize = 150 * MB;
    const ranges = computeChunkRanges(totalSize);

    // Aucune donnée perdue ni chevauchement : les segments couvrent [0, totalSize) exactement une fois.
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(totalSize - 1);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
    }

    // Aucun chunk ne dépasse la limite haute de 128 Mo (dernier chunk compris).
    for (const range of ranges) {
      expect(range.end - range.start + 1).toBeLessThanOrEqual(128 * MB);
    }
  });

  it("absorbe un petit reliquat dans le dernier chunk plutôt que de créer un chunk < 5 Mo", () => {
    // 64*2 + 3 Mo : un découpage naïf laisserait un dernier chunk de 3 Mo (< minimum de 5 Mo).
    const totalSize = 64 * MB * 2 + 3 * MB;
    const ranges = computeChunkRanges(totalSize);

    const lastChunkSize = ranges[ranges.length - 1].end - ranges[ranges.length - 1].start + 1;
    expect(lastChunkSize).toBeGreaterThanOrEqual(5 * MB);
    expect(ranges[ranges.length - 1].end).toBe(totalSize - 1);
  });

  it("reste sous la limite de 1000 chunks pour un fichier proche de 4 Go", () => {
    const totalSize = 4 * 1024 * MB - 1; // ~4 Go
    const ranges = computeChunkRanges(totalSize);
    expect(ranges.length).toBeLessThanOrEqual(1000);
    expect(ranges[ranges.length - 1].end).toBe(totalSize - 1);
  });
});
