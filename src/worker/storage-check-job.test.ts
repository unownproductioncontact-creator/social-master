import { describe, it, expect } from "vitest";
import { evaluateStorageAlert, R2_FREE_TIER_BYTES } from "@/worker/storage-check-job";

describe("evaluateStorageAlert", () => {
  it("n'alerte pas en dessous de 70 % du palier gratuit", () => {
    expect(evaluateStorageAlert(0).shouldAlert).toBe(false);
    expect(evaluateStorageAlert(R2_FREE_TIER_BYTES * 0.5).shouldAlert).toBe(false);
    expect(evaluateStorageAlert(R2_FREE_TIER_BYTES * 0.69).shouldAlert).toBe(false);
  });

  it("alerte à partir de 70 % du palier gratuit", () => {
    const result = evaluateStorageAlert(R2_FREE_TIER_BYTES * 0.7);
    expect(result.shouldAlert).toBe(true);
    expect(result.message).toContain("70 %");
    expect(result.message).toContain("7.0 Go / 10 Go");
  });

  it("alerte au-delà du palier (dépassement), sans planter", () => {
    const result = evaluateStorageAlert(R2_FREE_TIER_BYTES * 1.2);
    expect(result.shouldAlert).toBe(true);
    expect(result.message).toContain("120 %");
  });

  it("le message mentionne le coût du dépassement et l'action possible", () => {
    const result = evaluateStorageAlert(R2_FREE_TIER_BYTES * 0.9);
    expect(result.message).toContain("médiathèque");
    expect(result.message).toMatch(/0,015/);
  });
});
