import { describe, it, expect } from "vitest";
import { computeChunkRanges } from "@/lib/providers/tiktok";

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
