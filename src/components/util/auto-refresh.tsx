"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Socle auto-refresh (P2-9) : revalide silencieusement les données de la page courante
 * (`router.refresh()`, sans navigation ni perte de scroll) tant que l'onglet reste visible, et
 * immédiatement au retour sur l'onglet après une absence — utile pour une app de planification où
 * le worker pg-boss change le statut d'un post en arrière-plan pendant que le user regarde
 * ailleurs. Ne rafraîchit jamais un onglet en arrière-plan (pas d'appel réseau superflu).
 * Ne rend rien : composant purement effet de bord.
 *
 * ⚠️ Pas encore monté nulle part (le montage dans les pages concernées viendra en vague 3,
 * voir la mission P2-9 du CLAUDE.md) — l'import seul de ce composant n'a aucun effet.
 */
export function AutoRefresh({ intervalMs = 60000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, intervalMs);

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs, router]);

  return null;
}
