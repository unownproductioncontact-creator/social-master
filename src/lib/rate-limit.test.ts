import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit, _resetRateLimitStoreForTests } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("autorise les N premières tentatives puis bloque la suivante", () => {
    const opts = { max: 3, windowMs: 60_000 };
    expect(checkRateLimit("k1", opts).allowed).toBe(true);
    expect(checkRateLimit("k1", opts).allowed).toBe(true);
    expect(checkRateLimit("k1", opts).allowed).toBe(true);

    const fourth = checkRateLimit("k1", opts);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
  });

  it("des clés distinctes ont des compteurs indépendants", () => {
    const opts = { max: 1, windowMs: 60_000 };
    expect(checkRateLimit("a", opts).allowed).toBe(true);
    // "a" est maintenant épuisée, mais "b" doit rester autorisée : pas de fuite entre clés.
    expect(checkRateLimit("b", opts).allowed).toBe(true);
    expect(checkRateLimit("a", opts).allowed).toBe(false);
  });

  it("réautorise une fois la fenêtre expirée (reset)", () => {
    vi.useFakeTimers();
    const opts = { max: 1, windowMs: 1000 };

    expect(checkRateLimit("reset-key", opts).allowed).toBe(true);
    expect(checkRateLimit("reset-key", opts).allowed).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(checkRateLimit("reset-key", opts).allowed).toBe(true);
  });

  it("continue d'incrémenter le compteur pendant le blocage (n'allonge pas la fenêtre, mais ne la réinitialise pas non plus prématurément)", () => {
    vi.useFakeTimers();
    const opts = { max: 1, windowMs: 1000 };

    expect(checkRateLimit("spam-key", opts).allowed).toBe(true);

    vi.advanceTimersByTime(500);
    const blocked1 = checkRateLimit("spam-key", opts);
    expect(blocked1.allowed).toBe(false);
    expect(blocked1.retryAfterSec).toBeLessThanOrEqual(1);

    // Encore bloqué juste avant l'expiration réelle de la fenêtre initiale.
    vi.advanceTimersByTime(400);
    expect(checkRateLimit("spam-key", opts).allowed).toBe(false);

    // Fenêtre initiale (basée sur le tout premier hit) désormais expirée : réautorisé.
    vi.advanceTimersByTime(200);
    expect(checkRateLimit("spam-key", opts).allowed).toBe(true);
  });

  it("retryAfterSec reflète approximativement le temps restant avant reset", () => {
    vi.useFakeTimers();
    const opts = { max: 1, windowMs: 10_000 };

    checkRateLimit("timing-key", opts);
    vi.advanceTimersByTime(4000);
    const result = checkRateLimit("timing-key", opts);

    expect(result.allowed).toBe(false);
    // Il reste ~6s sur les 10s de fenêtre.
    expect(result.retryAfterSec).toBe(6);
  });

  it("purge paresseuse : une clé expirée n'influence pas une clé active nouvellement créée", () => {
    vi.useFakeTimers();
    const opts = { max: 1, windowMs: 500 };

    checkRateLimit("old-key", opts);
    vi.advanceTimersByTime(600);
    // Ce nouvel appel purge "old-key" en interne ; on vérifie juste l'absence d'effet de bord observable.
    expect(checkRateLimit("new-key", opts).allowed).toBe(true);
    // "old-key" doit se comporter comme neuve après expiration (nouvelle fenêtre).
    expect(checkRateLimit("old-key", opts).allowed).toBe(true);
  });
});
