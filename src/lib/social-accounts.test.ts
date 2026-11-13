// Plusieurs comptes par réseau (CLAUDE.md §44) : règles pures — compte principal, noms, désignation par le
// connecteur (« clips », « @pseudo »), ordre de priorité du choix, jamais de repli silencieux sur un autre compte.
import { describe, it, expect } from "vitest";
import {
  accountsOf,
  principalAccount,
  accountDisplayName,
  accountFullName,
  matchAccountRef,
  resolveAccount,
  cleanAccountLabel,
  accountChoicesFrom,
} from "@/lib/social-accounts";

const at = (iso: string) => new Date(iso);
const main = { id: "yt-main", platform: "YOUTUBE", username: "Pokemoha", label: null, createdAt: at("2026-07-13T10:00:00Z") };
const clips = { id: "yt-clips", platform: "YOUTUBE", username: "Pokemoha Clips", label: "Clips", createdAt: at("2026-11-13T10:00:00Z") };
const ig = { id: "ig-main", platform: "INSTAGRAM", username: "moha_pokemoh", label: "Principal", createdAt: at("2026-07-09T10:00:00Z") };
const igClips = { id: "ig-clips", platform: "INSTAGRAM", username: "pokemoha_clips", label: "Clips", createdAt: at("2026-11-13T11:00:00Z") };
const fb = { id: "fb", platform: "FACEBOOK", username: "Pokemoha", label: null, createdAt: at("2026-10-20T10:00:00Z") };
const all = [clips, igClips, main, ig, fb];

describe("compte principal", () => {
  it("le plus ancien d'un réseau, peu importe l'ordre reçu", () => {
    expect(accountsOf(all, "YOUTUBE").map((a) => a.id)).toEqual(["yt-main", "yt-clips"]);
    expect(principalAccount(all, "INSTAGRAM")?.id).toBe("ig-main");
    expect(principalAccount(all, "TIKTOK")).toBeUndefined();
  });

  it("à date égale, ordre stable par identifiant", () => {
    const a = { ...main, id: "b" };
    const b = { ...main, id: "a" };
    expect(accountsOf([a, b], "YOUTUBE").map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("noms affichés", () => {
  it("nom donné, sinon @pseudo (nom de Page pour Facebook)", () => {
    expect(accountDisplayName(clips)).toBe("Clips");
    expect(accountDisplayName(main)).toBe("@Pokemoha");
    expect(accountDisplayName(fb)).toBe("Pokemoha");
    expect(accountFullName(igClips)).toBe("Clips (@pokemoha_clips)");
    expect(accountFullName(main)).toBe("@Pokemoha");
  });

  it("nom nettoyé, 40 caractères, vide = pas de nom", () => {
    expect(cleanAccountLabel("  Mes   clips ")).toBe("Mes clips");
    expect(cleanAccountLabel("   ")).toBeNull();
    expect(cleanAccountLabel("x".repeat(60))).toHaveLength(40);
  });
});

describe("désignation par le connecteur", () => {
  it("nom (casse et accents ignorés), @pseudo, identifiant, « principal »", () => {
    expect(matchAccountRef(all, "YOUTUBE", "clips")?.id).toBe("yt-clips");
    expect(matchAccountRef(all, "YOUTUBE", " CLIPS ")?.id).toBe("yt-clips");
    expect(matchAccountRef(all, "INSTAGRAM", "@pokemoha_clips")?.id).toBe("ig-clips");
    expect(matchAccountRef(all, "INSTAGRAM", "ig-main")?.id).toBe("ig-main");
    expect(matchAccountRef(all, "YOUTUBE", "principal")?.id).toBe("yt-main");
    expect(matchAccountRef(all, "YOUTUBE", "Principale")?.id).toBe("yt-main");
    expect(matchAccountRef([{ ...clips, label: "Clipé" }], "YOUTUBE", "clipe")?.id).toBe("yt-clips");
  });

  it("le nom d'un compte d'un autre réseau ne compte pas", () => {
    expect(matchAccountRef(all, "TIKTOK", "clips")).toBeUndefined();
    expect(matchAccountRef(all, "YOUTUBE", "ig-clips")).toBeUndefined();
  });
});

describe("choix du compte d'une cible", () => {
  it("par défaut : le principal ; en modification : le compte déjà choisi", () => {
    expect(resolveAccount(all, "YOUTUBE", {})).toEqual({ account: main });
    expect(resolveAccount(all, "YOUTUBE", { previousAccountId: "yt-clips" })).toEqual({ account: clips });
    // Compte du brouillon déconnecté depuis : retour au principal.
    expect(resolveAccount(all, "YOUTUBE", { previousAccountId: "disparu" })).toEqual({ account: main });
  });

  it("identifiant explicite > nom > compte du brouillon ; null = le principal", () => {
    expect(resolveAccount(all, "YOUTUBE", { accountId: "yt-clips", accountRef: "principal" })).toEqual({ account: clips });
    expect(resolveAccount(all, "YOUTUBE", { accountRef: "clips", previousAccountId: "yt-main" })).toEqual({ account: clips });
    expect(resolveAccount(all, "YOUTUBE", { accountId: null, previousAccountId: "yt-clips" })).toEqual({ account: main });
    expect(resolveAccount(all, "YOUTUBE", { accountRef: null, previousAccountId: "yt-clips" })).toEqual({ account: main });
  });

  it("désignation inconnue = erreur avec la liste des comptes, jamais un autre compte", () => {
    const byRef = resolveAccount(all, "YOUTUBE", { accountRef: "gaming" });
    expect("error" in byRef && byRef.error).toMatch(/Aucun compte YouTube « gaming ».*Clips \(@Pokemoha Clips\)/);
    const byId = resolveAccount(all, "INSTAGRAM", { accountId: "yt-clips" });
    expect("error" in byId && byId.error).toMatch(/introuvable/);
    const none = resolveAccount(all, "TIKTOK", {});
    expect("error" in none && none.error).toBe("Connectez d'abord votre compte TikTok.");
  });
});

describe("choix proposés dans le composer", () => {
  it("par réseau, le principal d'abord, réseaux sans compte absents", () => {
    expect(accountChoicesFrom(all)).toEqual({
      INSTAGRAM: [
        { id: "ig-main", name: "Principal (@moha_pokemoh)" },
        { id: "ig-clips", name: "Clips (@pokemoha_clips)" },
      ],
      YOUTUBE: [
        { id: "yt-main", name: "@Pokemoha" },
        { id: "yt-clips", name: "Clips (@Pokemoha Clips)" },
      ],
      FACEBOOK: [{ id: "fb", name: "Pokemoha" }],
    });
  });
});
