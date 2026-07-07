import { describe, it, expect, afterEach } from "vitest";
import { pgConnectionConfig } from "@/lib/db-ssl";

const ORIGINAL_URL = process.env.DATABASE_URL;

afterEach(() => {
  process.env.DATABASE_URL = ORIGINAL_URL;
});

describe("pgConnectionConfig", () => {
  it("retire sslmode de l'URL Supabase et force ssl no-verify (piège pg : le parsing de l'URL écrase la config explicite)", () => {
    process.env.DATABASE_URL =
      "postgresql://postgres.abc123:motdepasse@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require";
    const config = pgConnectionConfig();
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).toContain("aws-0-eu-west-1.pooler.supabase.com:5432");
    expect(config.connectionString).toContain("postgres.abc123:motdepasse");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("retire tous les paramètres SSL (sslmode, ssl, sslrootcert…) mais préserve les autres", () => {
    process.env.DATABASE_URL =
      "postgresql://u:p@db.example.com:5432/mydb?sslmode=no-verify&ssl=true&sslrootcert=/tmp/ca.pem&application_name=social-master";
    const config = pgConnectionConfig();
    expect(config.connectionString).not.toMatch(/sslmode|sslrootcert|[?&]ssl=/);
    expect(config.connectionString).toContain("application_name=social-master");
  });

  it("ne force PAS ssl en local (serveur prisma dev, pas de TLS)", () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:51214/template1";
    const config = pgConnectionConfig();
    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).toContain("localhost:51214");
  });

  it("force ssl no-verify pour tout hôte distant même sans paramètre sslmode", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db.example.com:5432/mydb";
    expect(pgConnectionConfig().ssl).toEqual({ rejectUnauthorized: false });
  });

  it("URL vide ou invalide : renvoie la valeur brute sans crasher au chargement", () => {
    process.env.DATABASE_URL = "";
    expect(pgConnectionConfig()).toEqual({ connectionString: "", ssl: undefined });
    process.env.DATABASE_URL = "pas une url";
    expect(pgConnectionConfig()).toEqual({ connectionString: "pas une url", ssl: undefined });
  });
});
