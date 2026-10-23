// Rythme d'interrogation de la base par le worker (CLAUDE.md §42) : chaque file écoutée a son propre
// délai, jamais le défaut de 2 s de pg-boss — 9 files à 2 s coûtaient ~15 Go/mois de bande passante
// Render, jour et nuit, pour des files presque toujours vides.
import { describe, it, expect, vi } from "vitest";

const boss = {
  start: vi.fn(async () => {}),
  createQueue: vi.fn(async () => {}),
  schedule: vi.fn(async () => {}),
  work: vi.fn<(name: string, options: object, handler: unknown) => Promise<string>>(async () => "worker-id"),
};
vi.mock("@/worker/boss", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/worker/boss")>()),
  getBoss: () => boss,
}));

const { startWorker } = await import("@/worker");
const { POLLING_INTERVAL_SECONDS } = await import("@/worker/boss");

describe("rythme d'interrogation des files", () => {
  it("chaque file écoutée a son délai, d'au moins 5 s", async () => {
    await startWorker();
    const polled = Object.fromEntries(
      boss.work.mock.calls.map(([name, options]) => [
        name,
        (options as { pollingIntervalSeconds?: number }).pollingIntervalSeconds,
      ])
    );
    expect(polled).toStrictEqual(POLLING_INTERVAL_SECONDS);
    for (const seconds of Object.values(polled)) expect(seconds).toBeGreaterThanOrEqual(5);
  });
});
