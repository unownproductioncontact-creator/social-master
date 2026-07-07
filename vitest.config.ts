import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Le test d'intégration du scheduler ouvre des connexions Prisma + pg-boss ; les paralléliser
    // avec d'autres fichiers de test n'apporte rien ici (peu de tests) et évite toute contention
    // sur la petite base Postgres locale de dev.
    fileParallelism: false,
    // pg-boss (démarrage + création de queue) contre le serveur Postgres allégé de `prisma dev`
    // est nettement plus lent que le défaut de 5s de Vitest.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      // "server-only" n'est pas un vrai package npm — Next.js le résout en interne dans son bundler.
      // Vitest utilise son propre résolveur : on le remplace par un stub vide pour les tests.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
});
