#!/bin/sh
# Orchestrateur de tests (voir CLAUDE.md §16).
#
# Pourquoi : les suites d'intégration pg-boss/Prisma passent chacune en ISOLATION sur moteur calme,
# mais s'empoisonnent mutuellement dans un run unique — le moteur `prisma dev` allégé accumule un
# état de protocole dégradé (bind message/portal/ECONNRESET) entre fichiers, et un moteur « chaud »
# laissé par un run précédent contamine même les suites légères. Jamais observé sur un vrai Postgres
# (Supabase en prod). Chaque groupe démarre donc sur un moteur fraîchement redémarré dont la
# disponibilité est VÉRIFIÉE (db push en boucle), pas présumée. Prérequis : serveur dev Next ARRÊTÉ.
set -e

fresh_engine() {
  npx prisma dev stop default >/dev/null 2>&1 || true
  sleep 2
  npx prisma dev -d >/dev/null 2>&1
  i=0
  until npx prisma db push >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -ge 15 ]; then
      echo "✗ Le moteur prisma dev ne répond pas après 15 tentatives." >&2
      exit 1
    fi
    sleep 2
  done
}

echo "— groupe 1/3 : suites unitaires et DB légères (moteur frais) —"
fresh_engine
npx vitest run \
  --exclude "**/scheduler.test.ts" \
  --exclude "**/bulk-scheduler.integration.test.ts"

echo "— groupe 2/3 : scheduler (moteur frais) —"
fresh_engine
npx vitest run src/lib/scheduler.test.ts

echo "— groupe 3/3 : bulk-scheduler (moteur frais) —"
fresh_engine
npx vitest run src/lib/bulk-scheduler.integration.test.ts

echo "✓ Les 3 groupes sont verts."
