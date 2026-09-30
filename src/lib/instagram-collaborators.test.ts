import { describe, it, expect } from "vitest";
import {
  collaboratorsFromOptions,
  normalizeInstagramCollaborators,
  parseInstagramCollaborators,
  validateInstagramCollaborators,
} from "@/lib/instagram-collaborators";

describe("parseInstagramCollaborators", () => {
  it("accepte virgules, espaces et retours à la ligne ; retire les @ ; minuscules ; dédoublonne", () => {
    expect(parseInstagramCollaborators(" @Dokkan.Essentials, moha_pokemoh\n@dokkan.essentials ;  ")).toEqual([
      "dokkan.essentials",
      "moha_pokemoh",
    ]);
  });

  it("saisie vide → liste vide", () => {
    expect(parseInstagramCollaborators("   ")).toEqual([]);
  });
});

describe("validateInstagramCollaborators", () => {
  it("3 pseudos valides → aucune erreur", () => {
    expect(validateInstagramCollaborators(["a.b", "c_d", "e1"])).toBeNull();
  });

  it("plus de 3 → erreur (limite de l'API)", () => {
    expect(validateInstagramCollaborators(["a", "b", "c", "d"])).toMatch(/3 collaborateurs/);
  });

  it("caractère interdit ou pseudo trop long → erreur nommant le pseudo", () => {
    expect(validateInstagramCollaborators(["bon", "mau-vais"])).toMatch(/mau-vais/);
    expect(validateInstagramCollaborators(["a".repeat(31)])).toMatch(/invalide/);
  });

  it("le compte connecté ne peut pas s'inviter lui-même (casse et @ ignorés)", () => {
    expect(validateInstagramCollaborators(["moha_pokemoh"], "@Moha_Pokemoh")).toMatch(/vous-même/);
  });
});

describe("collaboratorsFromOptions", () => {
  it("lit platformOptions.collaborators et ignore ce qui n'est pas une liste de chaînes", () => {
    expect(collaboratorsFromOptions({ coverTimeMs: 1200, collaborators: ["@A", "b", 3] })).toEqual(["a", "b"]);
    expect(collaboratorsFromOptions({ collaborators: "a" })).toEqual([]);
    expect(collaboratorsFromOptions(null)).toEqual([]);
  });

  it("normalizeInstagramCollaborators conserve l'ordre de saisie", () => {
    expect(normalizeInstagramCollaborators(["zed", "Alpha", "zed"])).toEqual(["zed", "alpha"]);
  });
});
