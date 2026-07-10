import { describe, it, expect } from "vitest";
import { maxCountInSlidingWindow, TIKTOK_WINDOW_MS } from "@/lib/tiktok-window";

const H = 3600 * 1000; // une heure en ms

describe("maxCountInSlidingWindow", () => {
  it("liste vide → 0", () => {
    expect(maxCountInSlidingWindow([], TIKTOK_WINDOW_MS)).toBe(0);
  });

  it("un seul élément → 1", () => {
    expect(maxCountInSlidingWindow([42], TIKTOK_WINDOW_MS)).toBe(1);
  });

  it("bord EXACT de fenêtre : un élément à t+windowMs ouvre une nouvelle fenêtre (borne haute exclue)", () => {
    // Deux éléments espacés d'exactement 24 h → chacun dans sa propre fenêtre → max 1.
    expect(maxCountInSlidingWindow([0, TIKTOK_WINDOW_MS], TIKTOK_WINDOW_MS)).toBe(1);
    // Juste EN DEÇÀ de 24 h → les deux tiennent dans la même fenêtre → 2.
    expect(maxCountInSlidingWindow([0, TIKTOK_WINDOW_MS - 1], TIKTOK_WINDOW_MS)).toBe(2);
  });

  it("lot étalé multi-jours (1 vidéo/jour sur 7 jours) → jamais plus de 1 par fenêtre de 24 h", () => {
    const day = 24 * H;
    const times = [0, day, 2 * day, 3 * day, 4 * day, 5 * day, 6 * day];
    expect(maxCountInSlidingWindow(times, TIKTOK_WINDOW_MS)).toBe(1);
  });

  it("lot concentré (6 vidéos en 3 h) → toutes dans la même fenêtre", () => {
    const times = [0, 30 * 60 * 1000, H, 90 * 60 * 1000, 2 * H, 3 * H];
    expect(maxCountInSlidingWindow(times, TIKTOK_WINDOW_MS)).toBe(6);
  });

  it("chevauchement partiel : 5 le jour 1 (18h–22h) + 5 le jour 2 (18h–22h) → max 5, pas 10", () => {
    const day2 = 24 * H;
    const times = [
      18 * H, 19 * H, 20 * H, 21 * H, 22 * H, // jour 1
      day2 + 18 * H, day2 + 19 * H, day2 + 20 * H, day2 + 21 * H, day2 + 22 * H, // jour 2
    ];
    expect(maxCountInSlidingWindow(times, TIKTOK_WINDOW_MS)).toBe(5);
  });

  it("fenêtre glissante trouve le pic même quand il n'est pas ancré sur le premier élément", () => {
    // t=0 isolé, puis un paquet de 4 resserré 40 h plus tard → le pic (4) n'est pas au début.
    const times = [0, 40 * H, 40 * H + H, 40 * H + 2 * H, 40 * H + 3 * H];
    expect(maxCountInSlidingWindow(times, TIKTOK_WINDOW_MS)).toBe(4);
  });

  it("ordre d'entrée indifférent (tri interne) et doublons comptés", () => {
    expect(maxCountInSlidingWindow([3 * H, 0, 2 * H, H, 0], TIKTOK_WINDOW_MS)).toBe(5);
  });

  it("respecte une largeur de fenêtre arbitraire (paramètre windowMs)", () => {
    // Fenêtre de 2 h : sur [0, 1h, 2h, 3h], le pic est {0,1h} ou {1h,2h}… soit 2 (2h exclu de [0,2h)).
    expect(maxCountInSlidingWindow([0, H, 2 * H, 3 * H], 2 * H)).toBe(2);
  });
});
