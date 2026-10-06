import { describe, expect, it } from "vitest";
import { TRIAL_STRATEGY_BY_CHOICE, trialChoice, trialFromOptions } from "./instagram-trial";

describe("trialFromOptions", () => {
  it("lit les deux stratégies Meta stockées dans platformOptions.trial", () => {
    expect(trialFromOptions({ trial: "MANUAL" })).toBe("MANUAL");
    expect(trialFromOptions({ trial: "SS_PERFORMANCE", collaborators: [] })).toBe("SS_PERFORMANCE");
  });

  it("Reel classique (null) si absent, inconnu ou JSON mal formé", () => {
    expect(trialFromOptions(null)).toBeNull();
    expect(trialFromOptions({})).toBeNull();
    expect(trialFromOptions({ trial: "manual" })).toBeNull();
    expect(trialFromOptions({ trial: true })).toBeNull();
    expect(trialFromOptions("MANUAL")).toBeNull();
  });
});

describe("valeurs du connecteur", () => {
  it("manual/auto ↔ MANUAL/SS_PERFORMANCE dans les deux sens", () => {
    expect(TRIAL_STRATEGY_BY_CHOICE.manual).toBe("MANUAL");
    expect(TRIAL_STRATEGY_BY_CHOICE.auto).toBe("SS_PERFORMANCE");
    expect(trialChoice("MANUAL")).toBe("manual");
    expect(trialChoice("SS_PERFORMANCE")).toBe("auto");
    expect(trialChoice(null)).toBeUndefined();
  });
});
