# Chantier YouTube Shorts — JALONS DE REPRISE

> **But de ce fichier** : reprendre le chantier en < 2 min après une coupure (limite de session/tokens, crash).
> **Règle** : mis à jour à CHAQUE jalon ; commit local à chaque jalon vérifié (`tsc` vert minimum) ; **push uniquement aux jalons INTÉGRATION** (chaque push = déploiement Render).
> La SPEC du chantier est dans `CLAUDE.md §25` (faits API vérifiés + décisions actées). Le plan global : vague 1 moteur → vague 2 UI → intégration (tsc+tests+build) → commit+push+deploy+vérif prod → checklist Google Cloud user.

## État courant : ⏳ VAGUE 2 UI EN COURS (lancée le 11/07 ~11h40)

- Vague 2 : run `wf_9da43437-ba4`, script `/Users/mohamed/.claude/projects/-Users-mohamed-social-master/a0393529-ad6d-4567-8874-d9f1a3a3b2f3/workflows/scripts/youtube-shorts-vague-2-wf_9da43437-ba4.js`
- **Reprise après coupure** : `Workflow({ scriptPath: <ci-dessus>, resumeFromRunId: "wf_9da43437-ba4" })` — sinon relire J2 ci-dessous (contrats J1→J2 notés) et relancer les lots C/D.

## Jalons

### ✅ J0 — Socle (commit local `183e0d2`, 11/07 ~01h05)
Enums Prisma `Platform.YOUTUBE` + `PostContentType.YOUTUBE_SHORT` (+ `prisma generate`), `platformLabel` YouTube, `ServedPlatform` élargi, spec `CLAUDE.md §25`. tsc vert.

### ✅ J0bis — Placeholder compilation (non commité, dans l'arbre)
`post-composer-form.tsx` : `targetYoutube: false` passé à `savePostDraft` (placeholder, la vraie checkbox = vague 2 lot C). Nécessaire car A2 a déjà étendu le schéma zod de `savePostDraft`.

### ✅ J1 — Vague 1 MOTEUR (commit local `4c6d02c`, 11/07 ~11h35)
**Déjà sur disque (partiel, compilable, NON commité)** :
- A1 : `src/lib/providers/youtube.ts` + `youtube-title.ts` (nouveaux), `src/app/api/oauth/youtube/{start,callback}/route.ts` (nouveaux), `src/lib/errors.ts` (classifyYouTubeError), `src/worker/publish-job.ts` (branche YOUTUBE).
- A2 : `src/lib/content-type.ts(+test)` (computeYouTubeContentType), `src/lib/media-validation.ts(+test)`, `src/lib/actions/posts.ts` (targetYoutube/youtubeTitle).

**Manque (à vérifier au rapport des agents)** :
- A1 : `youtube.test.ts`, extension `errors.test.ts`, no-op YOUTUBE dans `token-refresh-job.ts`, `.env.example` (GOOGLE_CLIENT_ID/SECRET).
- A2 : offsets `scheduler.ts` (TikTok H / IG H+5 / **YouTube H+10**), `bulk-scheduler.ts` (platforms.youtube), `bulk-ui.ts` (CardPlatforms.youtube + youtubeTime custom) + tests.

**FAIT** : A1+A2 verts + retouches d'intégration (helpers titre UNIFIÉS sur `content-type.ts` — `resolveYouTubeTitle` avec repli ultime « Short », `youtube-title.ts` supprimé ; branche YOUTUBE du health-check `social-account-health.ts` (refresh→persist→channels.list) ; zod `actions/bulk.ts` youtube). tsc vert, 3 groupes verts (59 purs youtube/errors/content-type, scheduler 13, bulk 20).
**Contrats pour J2** : helpers UI = `youtubeTitleFallback`/`resolveYouTubeTitle`/`YOUTUBE_TITLE_MAX_LENGTH` depuis `@/lib/content-type` (client-safe) ; callback OAuth redirige `/connections?youtube=connected|error&detail=…` ; bug latent à corriger en D : `bulk-card.tsx::applyWakeTime` (branche else écrit youtubeTime dans instagramTime).

### ⬜ J2 — Vague 2 UI
2 lots parallèles : **C (Opus)** composer mono (checkbox YouTube + champ « Titre YouTube » ≤100 défaut 1re ligne de légende, preview, servedPlatforms YOUTUBE, remplace le placeholder J0bis) + `composer/page.tsx`/`[postId]/page.tsx` (prop youtubeConnected) ; **D (Sonnet)** bulk UI (checkbox youtube par carte + défauts + youtubeTime en mode custom, hint titre auto), `connections/page.tsx` (3e SocialAccountCard, connectUrl `/api/oauth/youtube/start`), `connections-card.tsx` dashboard (ligne YouTube), `media-card.tsx` (ligne YouTube dans le popover de compatibilité). Contrats : voir §25 (platformOptions `{title?}`, filtres historiques inchangés).
**Fin J2** : tsc + tests → **commit local « jalon J2 »** + màj fichier.

### ⬜ J3 — INTÉGRATION (= le seul jalon avec PUSH)
tsc + `npm test` complet + `npm run build` + revue rapide du diff → commit final → **push** (déploiement Render auto) → vérifier `/api/healthz` (commit) + pages publiques → màj `CLAUDE.md` (§25 statut livré), mémoire, tâche #36, suppression de ce fichier (ou passage en « terminé »).

### ⬜ J4 — Actions USER (hors code) + tests empiriques jour 1
1. Google Cloud (projet Kiibiki) : écran de consentement → ajouter scope `youtube.upload` ; **Publishing status = In production** (PAS Testing : refresh tokens 7 jours sinon) ; créer client OAuth « Social Master » (Web) redirect `https://social-master-jitq.onrender.com/api/oauth/youtube/callback` ; poser `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` dans Render.
2. Connecter la chaîne dans /connections (écran « app non validée » attendu → Paramètres avancés → Continuer).
3. Tests empiriques : vidéo verticale <3 min → étagère Shorts ? refresh token >7 j ? plafond par chaîne ?

## Incidents notés
- 11/07 ~01h20 : vague 1 morte en vol (« API Error: Connection closed mid-response », les 2 agents) → travail partiel conservé, tsc réparé (placeholder J0bis).
- 11/07 ~01h30 : relance morte immédiatement (limite de session, reset 3h40).
- Relance 11/07 ~11h15 (en cours).
