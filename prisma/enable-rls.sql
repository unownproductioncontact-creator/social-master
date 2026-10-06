-- Supabase expose le schéma public via son API REST/GraphQL (rôles anon/authenticated), que l'app
-- n'utilise pas : elle passe uniquement par Prisma avec le rôle propriétaire des tables. Activer la
-- RLS SANS politique ferme cette API sans rien changer pour l'app (un propriétaire contourne la RLS de
-- ses tables, et seul le propriétaire peut l'activer). Rejoué à chaque démarrage après `prisma db push`
-- pour couvrir aussi les tables créées plus tard. Idempotent. CLAUDE.md §35.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
  END LOOP;
END $$;
