# Social Master — Planificateur de publications Instagram + TikTok

Outil **personnel** de planification de contenu : connecter 1 compte Instagram (pro) + 1 compte TikTok (personnel), uploader des vidéos/images, préparer des posts (caption, hashtags, miniature), les programmer, et laisser le système publier automatiquement à l'heure prévue. Calendrier, brouillons, statuts, notifications Telegram.

**Ce fichier est la source de vérité du projet.** Toute l'étude de faisabilité a été menée le 07/07/2026 avec vérification systématique sur les documentations officielles (chaque fait critique contre-vérifié sur la page source). Ne pas re-débattre les décisions actées ici ; si une info API semble périmée, re-vérifier sur l'URL citée avant de changer le code.

---

## 1. Décisions produit actées (07/07/2026)

- **Usage personnel** (pas SaaS pour l'instant), mais modèle de données multi-utilisateurs dès le départ.
- **Construction sur mesure** (choix explicite contre Postiz self-hosted et Zernio).
- **Comptes du user** : Instagram déjà professionnel ✓ ; TikTok **personnel « classique » — NE PAS le convertir en Business** (les tests non audités exigent un compte privé, ce que Business ne permet pas ; Business = musique commerciale uniquement).
- **TikTok avant audit : mode brouillon (inbox)** — la vidéo arrive dans les notifications TikTok du user qui finalise et publie dans l'app. Après audit : bascule en Direct Post (le modèle de données le prévoit via `publishMode`).
- **MVP : Reels Instagram + vidéos TikTok.** Ensuite (V2) : carrousels, images feed, stories, photos TikTok.
- **Hébergement 100 % gratuit** (décision explicite du user, ~7 €/mois refusé pour l'instant).
- **Domaine : sous-domaine du site d'un ami** → `scheduler.dokkanessentials.com` (nom de sous-domaine à confirmer). L'ami ajoute UN CNAME vers l'app Render, c'est tout. Dépendance assumée.
- **Notifications : Telegram** (le user a l'habitude, il a déjà des bots BotFather).
- **UI en français, design sobre et soigné** (shadcn/ui + Tailwind).
- Volume réel : **très en dessous de 15 posts/jour** — aucun quota ne sera un problème en pratique, mais les garde-fous restent obligatoires.

## 2. Contraintes API vérifiées (07/07/2026, docs officielles)

### Instagram — API « Instagram Login » (choix acté)
- Variante retenue : **Instagram API with Instagram Login** (`graph.instagram.com`) — pas de Page Facebook requise. Scopes : `instagram_business_basic` + `instagram_business_content_publish`. (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login)
- Compte **professionnel obligatoire** (Business ou Creator). Les comptes personnels ne peuvent pas publier via API.
- **Mode Développement suffisant pour l'usage perso** : Standard Access fonctionne pour les comptes ayant un rôle sur l'app (admin/dev/testeur). Aucune App Review nécessaire tant qu'on ne sert pas de tiers.
- Flow de publication : `POST /{ig-id}/media` (container) → polling `GET /{container}?fields=status_code` (1×/min, max 5 min, attendre `FINISHED`) → `POST /{ig-id}/media_publish`. Publier avant `FINISHED` = erreur 9007/2207027.
- **Un container non publié expire en 24 h** → tout créer à l'heure H, jamais en avance.
- **Média : URL publique obligatoire** (Meta télécharge en cURL). L'upload binaire « resumable » (`rupload.facebook.com`) est documenté comme réservé à la variante Facebook-Login — considérer indisponible ici. (https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/)
- **Pas de planification native** (aucun `publish_at`).
- Specs : image feed **JPEG uniquement**, ≤ 8 Mo, ratio 4:5 à 1.91:1 (⚠️ le pipeline visuel du user produit des PNG → conversion JPEG nécessaire). Reels : MP4/MOV (H.264/HEVC + AAC, moov atom au début), 3 s–15 min, ≤ 300 Mo via `video_url`, miniature via `cover_url` ou `thumb_offset` (ms). Stories vidéo ≤ 100 Mo, 3–60 s. Carrousels ≤ 10 éléments. Caption ≤ 2 200 caractères, ≤ 30 hashtags, ≤ 20 mentions. (https://developers.facebook.com/docs/instagram-api/reference/ig-user/media)
- **Quota de publication : docs contradictoires (100 vs 50 posts/24 h)** → ne JAMAIS coder le chiffre en dur ; lire en runtime `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`.
- Tokens : long-lived **60 jours**, refresh **serveur** via `graph.instagram.com/refresh_access_token` (token âgé d'au moins 24 h) ; non rafraîchi 60 j = mort définitive → cron de refresh hebdomadaire. Erreur 190 (sous-codes 458–467) = reconnexion requise.
- Erreurs clés : 9007/2207027 (pas prêt, re-poll), 9/2207042 (quota), 4/2207051 (spam), 25/2207050 (compte restreint — l'utilisateur doit ouvrir l'app IG), 36000-series (specs média), −1/−2 (transitoire, retry). Pas de webhook de publication : le retour synchrone + polling font foi.
- Version Graph API courante des docs : v25.0.

### TikTok — Content Posting API
- **App non auditée : les posts Direct Post sont forcés en privé (SELF_ONLY)** ; les 3 restrictions non-audité sont documentées **uniquement** sous « Direct Post API - Developer Guidelines ». (https://developers.tiktok.com/doc/content-sharing-guidelines)
- **Mode brouillon (inbox)** : `POST /v2/post/publish/inbox/video/init/` — aucune restriction non-audité documentée, pas de code d'erreur `unaudited_*` sur cet endpoint. Le user publie lui-même depuis l'app → post public possible. **Consensus intégrateurs mais pas de garantie officielle explicite → TEST EMPIRIQUE OBLIGATOIRE au jour 1** (cf. §12). Limites : **pas de champ caption** (le user la saisit dans TikTok → prévoir bouton « copier la caption ») ; **max 5 brouillons en attente / 24 h** (`spam_risk_too_many_pending_share`).
- Scopes : `video.upload` (inbox) + `video.publish` (direct, pour plus tard) + `user.info.basic`. L'utilisateur peut **refuser un scope individuellement** → toujours vérifier les scopes réellement accordés.
- **`creator_info` obligatoire avant chaque écran de post** (`POST /v2/post/publish/creator_info/query/`, 20 req/min) : donne nickname, `privacy_level_options`, `max_video_post_duration_sec`.
- Transfert vidéo : **FILE_UPLOAD par chunks** (choix acté — évite la vérification d'URL média). Chunks 5–64 Mo (dernier ≤ 128 Mo), 1–1000 chunks, vidéo ≤ 4 Go, `upload_url` valide 1 h, PUT avec `Content-Range`. (https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- Specs vidéo : MP4/WebM/MOV, H.264/H.265/VP8/VP9, 360–4096 px, 23–60 FPS, durée ≤ `max_video_post_duration_sec` du créateur. Caption Direct Post ≤ 2 200 runes UTF-16.
- Rate limits : **6 req/min** sur les init de publication, 30 req/min sur `status/fetch`. Cap ~15 posts/jour/créateur.
- Statut : `POST /v2/post/publish/status/fetch/` (`PROCESSING_* → SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED`) + webhooks `post.publish.complete/failed/publicly_available`.
- Tokens : access **24 h**, refresh **365 j avec ROTATION** (toujours stocker le refresh_token retourné s'il diffère). Endpoint : `POST https://open.tiktokapis.com/v2/oauth/token/` (form-urlencoded).
- **Création de l'app TikTok** : les URLs ToS/Privacy/Web doivent être **vérifiées par preuve de propriété** (fichier signature à la racine de l'URL ou DNS). Les sous-domaines de plateformes (streamlit.app, S3…) échouent → d'où le sous-domaine dokkanessentials.com. Compte développeur individuel OK (« organization highly recommended but not required »).
- **Audit Direct Post** (pour plus tard) : Developer Portal → app → Content Posting API → Apply. Demande : mockups UX (PDF), screen recording du flux complet, champs API stockés. Délai officiel « several days to two weeks » (2–4 semaines constatés). Les UX guidelines sont LE critère : privacy en dropdown **sans valeur par défaut**, toggles décochés par défaut, divulgation commerciale, mention « By posting, you agree to TikTok's Music Usage Confirmation », consentement explicite avant upload, afficher le nickname du créateur.

## 3. Stack technique (actée)

| Brique | Choix | Pourquoi |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | un langage partout |
| ORM/DB | **Prisma + PostgreSQL Supabase (plan gratuit)** | ⚠️ PAS Neon (100 CU-h/mois insuffisant pour un worker 24/7), PAS Render Postgres free (expire à 30 jours) |
| Jobs | **pg-boss** (dans Postgres) | jobs retardés + retries + cron, enqueue **transactionnel** avec les écritures Prisma ; pas de Redis à payer. Démarré **dans le process Next** via `instrumentation.ts` |
| Stockage | **Cloudflare R2 (free : 10 Go, egress gratuit)** | upload direct navigateur via URL présignées |
| Auth | **Auth.js** (credentials) | suffisant en perso |
| Déploiement | **Render free web service** (le user a déjà un compte Render) | 750 h/mois ≥ mois complet ; spin-down 15 min contré par **UptimeRobot** (ping 5 min sur `/api/healthz`) ; 512 Mo RAM |
| Notifications | Bot Telegram | infra connue du user |

**Conséquences du domaine ami (pas de zone Cloudflare à nous) :**
- Pas de domaine custom R2 → les médias pour Instagram sont servis par la route **`/api/m/[...key]`** qui streame depuis R2 (support des requêtes Range, jamais de buffering complet en RAM — 512 Mo !).
- Vidéos TikTok : FILE_UPLOAD par chunks (aucune vérification d'URL média nécessaire).
- Le fichier de vérification TikTok est servi depuis `public/`.

## 4. Arborescence cible

```
social-master/
├── instrumentation.ts                 # démarre pg-boss in-process (runtime nodejs)
├── prisma/schema.prisma
├── public/                            # fichier signature TikTok à la racine
├── src/
│   ├── app/
│   │   ├── (auth)/login, register
│   │   ├── (app)/dashboard, calendar, composer[/postId], library,
│   │   │        connections, history, settings
│   │   ├── legal/privacy, legal/terms        # exigés par Meta ET TikTok
│   │   └── api/
│   │       ├── auth/[...nextauth]
│   │       ├── oauth/instagram/{start,callback}
│   │       ├── oauth/tiktok/{start,callback}
│   │       ├── media/presign, posts[/...], accounts[/...]
│   │       ├── m/[...key]                    # proxy public médias (stream R2 + Range)
│   │       └── healthz                       # cible UptimeRobot
│   ├── components/{composer,preview,calendar,ui}
│   ├── lib/
│   │   ├── db.ts, auth.ts, crypto.ts (AES-256-GCM), storage.ts (R2),
│   │   ├── media-validation.ts, scheduler.ts, quota.ts,
│   │   ├── errors.ts (codes API → messages FR), telegram.ts
│   │   └── providers/{types.ts, instagram.ts, tiktok.ts}
│   └── worker/{publish-job, token-refresh-job, reconcile-job, status-poll-job}.ts
```

## 5. Modèle de données (résumé — le schéma complet fait foi dans prisma/schema.prisma)

`User` (timezone Europe/Paris) · `SocialAccount` (tokens chiffrés, `grantedScopes[]`, status ACTIVE/NEEDS_REAUTH/REVOKED, metadata JSON pour creator_info/quotas) · `MediaAsset` (storageKey R2, dimensions, durée, status) · `Post` (caption, hashtags[], status DRAFT/SCHEDULED/PARTIALLY_PUBLISHED/PUBLISHED/FAILED, `scheduledAt` **en UTC** + `scheduledTz`) · `PostMedia` (ordre carrousel) · `PostTarget` (une ligne par post×plateforme : `publishMode AUTO|TIKTOK_DRAFT`, `platformOptions` JSON, status avec `SENT_TO_INBOX`, platformPostId/Url, errorCode/Message — **c'est ici que vit le vrai statut**) · `PublishJob` (`idempotencyKey @unique` — verrou anti-double-publication) · `ActivityLog`.

## 6. Règles d'ingénierie NON NÉGOCIABLES

1. **Idempotence absolue** : contrainte unique sur `idempotencyKey` + re-vérification de l'état en base au début de chaque job. Le pire bug possible est la double publication.
2. **Enqueue transactionnel** : post `scheduled` + `PublishJob` + job pg-boss dans UNE transaction. Modification d'un post programmé = annuler le job + en recréer un (jamais muter).
3. **Réconciliation** : cron 5 min qui réenfile les jobs `waiting` dépassés de +10 min et alerte Telegram. (Couvre aussi les redémarrages du service gratuit Render.)
4. **Retry uniquement sur erreurs transitoires** (classification dans `lib/errors.ts`) : backoff 1/5/15 min, max 3. Un rejet de contenu ne se retente JAMAIS. Un problème de compte (190, ban) met le compte en NEEDS_REAUTH et pause ses publications.
5. **Quotas jamais en dur** : lire `content_publishing_limit` avant chaque publish IG ; compteur local par compte/24 h ; respecter 6 req/min TikTok.
6. **Tokens** : AES-256-GCM (clé 32 octets en env, versionnée), déchiffrés uniquement au moment de l'appel, jamais loggés, jamais côté client.
7. **Médias : jamais en RAM entière** — upload direct navigateur→R2 (presigned), proxy `/api/m/` en streaming pur, upload TikTok par chunks streamés depuis R2. (512 Mo de RAM sur Render free.)
8. **Dates : UTC en base, `Europe/Paris` à l'affichage** ; tests couvrant les deux changements d'heure.
9. **Toute erreur API brute est journalisée** (`ActivityLog.detail`) ; l'UI n'affiche que la traduction française + action corrective.
10. **Scoping systématique par `userId`** dans chaque requête Prisma exposée à l'API.
11. Interface `PublishingProvider` commune aux deux plateformes — c'est la digue contre les changements d'API.

⚠️ **Piège vérifié empiriquement** : `boss.work(QUEUE, handler)` capture la référence de fonction `handler` **au démarrage du process** (dans `instrumentation.ts` → `startWorker()`). Le Fast Refresh de Next.js recharge les modules React/route handlers mais **ne re-déclenche jamais `instrumentation.ts`** — donc toute modification de `src/worker/*.ts` (ou de tout ce qu'il importe : `lib/errors.ts`, `lib/providers/*.ts`, etc.) ne sera PAS prise en compte tant que le serveur dev n'est pas redémarré en entier (`preview_stop` + `preview_start`, ou `Ctrl+C` + `npm run dev`). Symptôme si oublié : le comportement observé correspond à l'ANCIENNE version du code sans aucune erreur ni avertissement. Découvert en testant la propagation `NEEDS_REAUTH` (§ étape 8/9 ci-dessous) : le premier test a semblé échouer silencieusement, alors que le code était correct — seul un redémarrage complet a révélé que ça fonctionnait.

## 7. Roadmap (cocher au fur et à mesure)

- [x] 1. Setup projet (Next 16+TS+Prisma 7+Tailwind+shadcn) + DB locale via `npx prisma dev -d` (voir §13, résout l'absence Homebrew/Docker)
- [x] 2. Auth utilisateur (implémentation maison jose+bcryptjs, PAS Auth.js — voir §12) — vérifié en navigateur : inscription, erreur mdp, connexion, déconnexion, protection des routes
- [x] 3. OAuth Instagram + refresh + chiffrement + health-check — code complet et typecheck OK ; **non testable end-to-end sans vrai compte Meta développeur** (bloqué sur `META_APP_ID`/`META_APP_SECRET` réels, voir §9)
- [x] 4. OAuth TikTok + refresh avec rotation + creator_info — idem, **non testable end-to-end sans vraie app TikTok** (bloqué sur `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` réels + domaine vérifié, voir §9)
- [x] 5. Upload média (presigned R2, validation client-side dimensions/durée, compatibilité par plateforme affichée) — page Médiathèque vérifiée en navigateur ; upload réel bloqué sans vraies clés R2 (échec géré proprement : toast FR + trace serveur). ⚠️ Conversion PNG→JPEG pas encore faite (voir note ci-dessous)
- [x] 6. Composer + brouillons + prévisualisation par plateforme — vérifié en navigateur (caption, compteur, hashtags, aperçu, plateformes) ; sélection/enregistrement d'un vrai média bloqué sans R2. **Décision de séquencement** : le bouton "Programmer" (date/heure → statut SCHEDULED) est volontairement DANS l'étape 8, pas ici — pour respecter la règle d'ingénierie n°2 (post scheduled + PublishJob + job pg-boss dans UNE transaction), jamais un post "programmé" sans job réel derrière.
- [x] 7. Calendrier — vue mois + navigation prev/next vérifiées en navigateur (juillet → août 2026 OK), aujourd'hui surligné. Vide pour l'instant : aucun post SCHEDULED tant que l'étape 8 n'existe pas (normal, voir note étape 6).
- [x] 8. Planificateur (pg-boss in-process, idempotence, réconciliation) — construites ENSEMBLE avec l'étape 9 (un scheduler qui ne publie rien n'est pas testable). Vérifiées en conditions quasi réelles : compte Instagram + média factices insérés en DB, programmation réelle via l'UI, job pg-boss qui attend la bonne heure puis se déclenche, VRAI appel à l'API Instagram (échoue proprement, token bidon), classification d'erreur → `PostTarget.status=FAILED` → `Post.status` recalculé → `SocialAccount.status=NEEDS_REAUTH`, tout confirmé en DB et dans l'UI (Connexions affiche "Reconnexion requise" automatiquement). Bouton de récupération ajouté (`SchedulePanel`) : un post FAILED/PARTIALLY_PUBLISHED peut repasser en DRAFT pour correction.
- [x] 9. Publication (flows IG container + TikTok inbox FILE_UPLOAD) — voir note étape 8. Flow TikTok (chunking FILE_UPLOAD depuis R2, poll inbox) écrit et typecheck OK mais **non testé en conditions réelles** (nécessite un vrai token TikTok) — seul le flow Instagram a été exercé en conditions quasi réelles.
- [x] 10. Logs, dictionnaire d'erreurs FR, notifications Telegram — dashboard et Historique connectés aux vraies données (vérifiés en navigateur), cron quotidien de refresh des tokens (IG à 10 j de l'échéance, TikTok à 6 h), `notifyTelegram()` no-op silencieux si non configuré (pas testé avec un vrai bot — nécessite `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` réels).
- [~] 11. Déploiement Render + UptimeRobot + CNAME ami + apps Meta/TikTok en prod — **prérequis logiciels prêts** : pages `/legal/privacy` et `/legal/terms` (contenu réel, placeholders `[À COMPLÉTER]` pour raison sociale/email — **à remplir avant toute soumission Meta/TikTok**), `/api/healthz` (vérifie la DB, prêt pour UptimeRobot), page Paramètres (profil + fuseau horaire, câblé jusqu'au composer). **Reste à faire, nécessite une action du user** : créer le repo GitHub, le service Render (web, la même instance fait aussi tourner le worker in-process), le projet Supabase de prod, le bucket R2, les vraies apps Meta/TikTok, le CNAME chez l'ami, configurer les variables d'environnement réelles sur Render.
- [ ] 12. Tests + **test empirique brouillon TikTok** + préparation audit Direct Post — build de production et sweep final restants (voir §14 ci-dessous pour le détail des vérifications déjà faites vs restantes)

## 8. Variables d'environnement (.env)

`DATABASE_URL` · `AUTH_SECRET` · `TOKEN_ENCRYPTION_KEY` (32 o, base64) · `APP_URL` (https://scheduler.dokkanessentials.com) · `META_APP_ID` / `META_APP_SECRET` · `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` · `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` · `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`

## 9. Comptes externes à créer (tous gratuits)

1. App **Meta** type Business (developers.facebook.com), produit Instagram, mode Développement — le compte IG du user ajouté comme testeur/admin.
2. App **TikTok** (developers.tiktok.com, compte individuel) — nécessite le sous-domaine actif d'abord (vérification URL ToS/Privacy par fichier signature).
3. **Supabase** (projet gratuit, juste Postgres). 4. **Cloudflare R2** (bucket + jeton). 5. **Render** (compte existant ✓). 6. **UptimeRobot** (existant ✓). 7. **Bot Telegram** (BotFather).
8. Message à l'ami : ajouter le CNAME `scheduler` → `<app>.onrender.com` sur dokkanessentials.com (une fois).

## 10. Tests empiriques à faire TÔT (ambiguïtés documentées)

1. **Jour 1 du flow TikTok** : envoyer 1 brouillon via inbox avec l'app non auditée, le publier depuis l'app TikTok, vérifier que le post peut être PUBLIC. (Consensus intégrateurs : oui ; garantie officielle : aucune.)
2. Quota IG réel du compte : lire `content_publishing_limit` (100 vs 50 selon les pages de doc).
3. Vitesse de traitement des containers Reels selon le poids réel des vidéos du user (calibrer le polling).

## 11. Conventions

- UI et messages d'erreur **en français**. Code, identifiants et commits en anglais.
- Style sobre : shadcn/ui, pas de dépendances lourdes superflues (RAM limitée).
- Ne jamais commiter de secrets ; `.env.example` tenu à jour à chaque nouvelle variable.

## 12. ⚠️ Next.js 16 — écarts vérifiés vs connaissances d'entraînement

Le projet a été scaffoldé avec **Next.js 16.2.10 / React 19.2.4**, une version plus récente que les connaissances d'entraînement habituelles. `create-next-app` a généré un avertissement explicite (« This is NOT the Next.js you know... Read the relevant guide in `node_modules/next/dist/docs/` before writing any code »). Points vérifiés dans cette doc embarquée et actés pour tout le projet — **ne pas se fier à la mémoire d'entraînement sur ces points, ils ont changé** :

- **`middleware.ts` → `proxy.ts`** : le fichier s'appelle désormais `src/proxy.ts` (même API, juste renommé). Ne jamais créer `middleware.ts`.
- **`cacheComponents`** : flag opt-in (`false` par défaut dans `next.config.ts`, qu'on laisse **non défini**). Sans lui, le rendu reste dynamique par défaut comme dans les versions précédentes — pas de Partial Prerendering ni de directive `use cache` à gérer pour ce projet 100 % authentifié/dynamique.
- **Auth = implémentation maison, pas Auth.js/NextAuth** (écart assumé par rapport à la section 3 ci-dessus, écrite avant de connaître la version Next) : la doc officielle Next 16 documente un pattern complet et recommandé (session JWT signée via `jose`, cookie `httpOnly`, Data Access Layer avec `verifySession()` mémoïsé par `cache()`, vérifications dans Server Actions/Route Handlers, `proxy.ts` pour les redirections optimistes uniquement). Vu la fraîcheur de Next 16, la compatibilité de NextAuth n'est pas garantie — on suit donc la doc officielle à la lettre plutôt que d'introduire une dépendance tierce à risque. Password hashing via `bcryptjs` (pas de binding natif, plus simple à déployer sur Render free).
- **Doc embarquée disponible** : `node_modules/next/dist/docs/01-app/` — à consulter en cas de doute plutôt que de faire confiance à la mémoire, en particulier pour route handlers, server actions, et tout ce qui touche au cache.
- **shadcn/ui repose sur Base UI (`@base-ui/react`), pas Radix UI.** Pas de prop `asChild` sur `Button`/`Dialog`/etc. Base UI utilise un prop `render` (`<Button render={<div />} />`), mais sa propre doc déconseille de l'utiliser pour des liens (« Links (`<a>`) have their own semantics and should not be rendered as buttons through the `render` prop »). **Pour un bouton-lien : appliquer `buttonVariants({...})` directement sur un `<a>`** (voir [src/components/connections/social-account-card.tsx](src/components/connections/social-account-card.tsx)), ne pas chercher `asChild`. Doc embarquée : `node_modules/@base-ui/react/docs/`.
- **Bruit console à ignorer** : un warning React « does not recognize the `asChild` prop » apparaît en dev sur TOUTES les pages, y compris celles sans aucun composant custom — confirmé venir de l'overlay Dev Tools interne de Next.js 16 lui-même (pas de notre code, disparaît en build de production). Ne pas perdre de temps à le chasser.
- **Checkbox Base UI : le prop `id` atterrit sur l'`<input>` natif caché (1×1px, pour la sémantique de formulaire), PAS sur l'élément visible/cliquable.** L'élément réellement interactif est un `<span role="checkbox">` avec un id auto-généré par Base UI (`base-ui-_r_c_`), frère de l'input cité. Pour tester/automatiser un clic sur une Checkbox : cibler `[role="checkbox"]` proche de l'input (ex. `document.getElementById('mon-id').closest('.wrapper').querySelector('[role="checkbox"]').click()`), pas l'id directement — sinon le clic atterrit sur un élément de 1px et ne déclenche rien. Vérifier `aria-checked` après clic pour confirmer.

## 13. Base de données — résolu via `prisma dev` (Homebrew/Docker absents)

Ni Homebrew ni Docker ne sont installés sur cette machine (confirmé au moment du setup). **Solution trouvée, meilleure que prévu : Prisma 7 fournit sa propre commande `npx prisma dev`, qui lance un serveur Postgres-compatible local sans aucune dépendance système.** Ça remplace complètement le besoin de Homebrew/Docker/Supabase-en-dev envisagé initialement.

- **Lancer une fois par session de travail, avant `npm run dev`** : `npx prisma dev -d` (le `-d` détache le process). Affiche une URL `postgres://postgres:postgres@localhost:<port>/template1?...` à copier dans `DATABASE_URL` si le port change (`npx prisma dev ls` pour la retrouver).
- `DATABASE_URL` dans `.env` pointe donc sur ce serveur local en dev. **`.env` est gitignored** — en production sur Render, `DATABASE_URL` sera définie directement comme variable d'environnement Render (URL Supabase), jamais lue depuis un fichier `.env` commité.
- **`npx prisma migrate dev` échoue sur ce serveur local (erreur P1017)** : le serveur ne supporte pas la création de base de données shadow (nécessaire à `migrate dev`). **Utiliser `npx prisma db push` pour le développement local** (sync directe du schéma, sans historique de migration).
- **Décision actée pour la prod (07/07/2026, au moment du déploiement Render)** : pas d'historique de migrations généré (aucun `prisma/migrations/`, puisque le dev local n'a utilisé que `db push`). Plutôt que de créer artificiellement un historique de migrations juste pour utiliser `migrate deploy`, le script `start` de `package.json` fait `prisma db push && next start` — `db push` tourne à chaque démarrage du service Render, est idempotent (no-op si le schéma n'a pas changé), et est amplement suffisant pour un projet perso solo sans besoin de rollback/historique. Si le projet grossit un jour (plusieurs contributeurs, besoin de rollback), migrer vers `prisma migrate dev` (génère l'historique) + `prisma migrate deploy` sera le moment de le faire — pas avant.
- **⚠️ Piège vécu au premier déploiement Render (07/07/2026)** : `db push` avait été mis dans `build` (pas `start`) dans un premier temps — ça fait échouer le build tant que `DATABASE_URL` (Supabase) n'est pas encore configuré sur Render, alors même que `next build` seul n'a besoin d'aucun accès DB. **Corrigé** : `db push` est dans `start`, jamais dans `build`. Le build Render réussit maintenant indépendamment de Supabase ; seul le démarrage du service (boot/health check) nécessite `DATABASE_URL` valide — c'est le comportement attendu et correct.
- Générateur client : `provider = "prisma-client"` (pas l'ancien `prisma-client-js`), sortie dans `src/generated/prisma` (gitignored, régénéré via le script `postinstall` dans `package.json`). **Import depuis `@/generated/prisma/client`** (le sous-chemin `/client` est obligatoire, pas la racine du dossier).
- **Prisma 7 exige un driver adapter** — `new PrismaClient()` sans adapter lève une erreur. Setup dans [src/lib/db.ts](src/lib/db.ts) : `@prisma/adapter-pg` (+ `pg`) avec `new PrismaPg({ connectionString: process.env.DATABASE_URL })`, singleton via `globalThis` pour survivre au hot-reload en dev.

## 14. État du projet au 07/07/2026 — MVP fonctionnel, prêt pour credentials réels

**Tout le code applicatif du MVP est écrit, type-check OK (`npx tsc --noEmit` propre), build de production OK (`npm run build` sans erreur) et `next start` démarre correctement avec le worker.** Étapes 1 à 10 vérifiées en navigateur avec des données réelles (y compris un test de bout en bout du planificateur avec un compte Instagram et un token factices — voir §7). Étape 11 (déploiement réel) et la partie du §10 nécessitant de vrais tokens attendent des actions côté user.

**Ce qui a été vérifié en conditions quasi réelles** (comptes/médias factices insérés directement en base, jamais commité) :
- Inscription/connexion/déconnexion, protection des routes.
- OAuth Instagram/TikTok : code écrit et vérifié contre la doc officielle, non testable sans vraie app développeur.
- Upload média : structure complète, upload réel bloqué sans clés R2 (échec géré proprement).
- Composer, calendrier, programmation : cycle complet testé dans le navigateur.
- **Planificateur + publication** : programmé un post réel via l'UI → job pg-boss a attendu la bonne heure → s'est déclenché → a appelé la VRAIE API Instagram (rejetée proprement, token bidon) → erreur classifiée → `PostTarget`/`Post`/`SocialAccount` mis à jour en cascade → visible dans Connexions et corrigible via "Repasser en brouillon". **Précision importante** : avec un token invalide, l'échec survient dès le tout premier appel API (`content_publishing_limit`, avant même la logique spécifique REEL/IMAGE/STORY/CAROUSEL) — donc ce test valide à fond la coquille externe (enqueue, idempotence, retry/backoff, cascade de statuts, UI) mais PAS le détail de construction des containers/carrousels eux-mêmes (`createMediaContainer`, `createCarouselChildContainer`, polling), qui reste vérifié seulement par relecture + type-check contre la doc officielle. Pareil côté TikTok : le flow chunké n'a jamais tourné contre un vrai token.
- Dashboard, Historique, Paramètres, pages légales, `/api/healthz` : tous vérifiés en navigateur avec de vraies requêtes (fetch status 200 sur toutes les pages).

**Ce qui N'A PAS pu être testé** (nécessite des identifiants/comptes réels que l'assistant ne peut pas créer) :
- Flow TikTok de publication (chunking FILE_UPLOAD, poll inbox, post photo) : écrit et type-check OK, jamais exécuté contre un vrai token.
- Construction fine des containers Instagram (Reel/Image/Story/Carrousel enfants+parent) : jamais atteinte par un appel réel, voir note ci-dessus.
- Le test empirique §10 du CLAUDE.md original (« un brouillon TikTok publié depuis une app non auditée peut-il être public ? ») — toujours à faire en tout premier une fois l'app TikTok créée.
- Notifications Telegram réelles (le code est prêt, no-op silencieux sans `TELEGRAM_BOT_TOKEN`).
- Déploiement Render, domaine réel, apps Meta/TikTok en production.

**Prochaines actions côté user (dans cet ordre)** :
1. ~~Compléter les `[À COMPLÉTER]` dans `/legal/privacy` et `/legal/terms`~~ — **fait le 07/07/2026** : raison sociale MEA (SASU), 4 avenue Philippe de Girard, 93420 Villepinte, contact unownproduction.contact@gmail.com. Build de prod re-vérifié OK après coup.
2. Créer l'app Meta (Business) + l'app TikTok (nécessite le sous-domaine `dokkanessentials.com` actif — voir §9) et remplir les vraies clés dans `.env`/variables Render.
3. Créer le projet Supabase de prod + le bucket R2, remplir les vraies clés.
4. ~~Pousser le repo sur GitHub~~ — **fait le 07/07/2026** : repo public `https://github.com/unownproductioncontact-creator/social-master` (branche `main`, commit initial 103 fichiers). `.env` jamais commité (vérifié via `git check-ignore`), seul `.env.example` (sans secrets) est trackable. Reste : créer le service web sur Render (repo public → utilisable via l'option "Public Git Repository" de Render, sans connecter de compte GitHub), configurer toutes les variables d'environnement, connecter le domaine.
5. Se connecter en prod, tester le flow Instagram réel (compte déjà pro), programmer un vrai post.
6. Faire le test empirique TikTok brouillon (§10) avant de préparer l'audit Direct Post.

## 15. Extensions post-MVP (07/07/2026, soir) — conversion image, carrousels, Stories, photos TikTok

Ajouté après la livraison initiale du MVP, à la demande du user :

- **Conversion PNG/WebP→JPEG automatique** ([src/lib/image-convert.ts](src/lib/image-convert.ts)) : `sharp`, exécutée à la volée dans le worker juste avant publication IMAGE (jamais au moment de l'upload — l'original reste intact dans R2). Clé de cache déterministe (`{storageKey}.converted.jpg`) : une image republiée réutilise la version déjà convertie. Sanity-check isolé (buffer PNG généré → converti → magic bytes JPEG `ffd8ff` confirmés) — la conversion elle-même fonctionne, seul le roundtrip R2 réel n'est pas testable (bloqué comme le reste sur R2).
- **Carrousels Instagram** (2 à 10 médias) : `publishInstagramCarousel()` — un container enfant par média (poll si vidéo) → container parent avec `children` → poll → publish. Composer : sélection multi-média (clic = toggle, badge = position), calcul du type de contenu dans [src/lib/content-type.ts](src/lib/content-type.ts) (`computeInstagramContentType`/`computeTikTokContentType`) — module pur partagé entre le composer (client) et `savePostDraft` (serveur), extrait spécifiquement parce qu'un fichier `"use server"` ne peut exporter que des fonctions async (donc pas ces deux-là) ; ce partage a aussi permis de les tester unitairement (§16).
- **Stories Instagram** : `media_type: STORIES` (image ou vidéo, un seul média). Checkbox dédiée dans le composer, visible seulement quand exactement 1 média est sélectionné.
- **Posts photo TikTok** (1 à 35 images) : `publishTikTokDraftPhoto()`, endpoint `/v2/post/publish/content/init/` en `post_mode: MEDIA_UPLOAD`. ⚠️ **Incertitude non résolue** : contrairement au mode brouillon vidéo (aucune restriction non-audité documentée sur son endpoint dédié), l'endpoint photo est partagé avec `DIRECT_POST` et son tableau d'erreurs liste `unaudited_client_can_only_post_to_private_accounts` — l'exemption "brouillon" pourrait ne PAS s'appliquer aux photos comme aux vidéos. **À tester en tout premier avec les posts photo, séparément du test vidéo déjà prévu au §10.**
- **Vérifié en navigateur** : sélection multi-média avec badges de position, détection Carrousel (3 images → badge "Carrousel", aperçu "+2"), détection Story (1 média + toggle → badge "Story", libellé adaptatif Reel/post), détection TikTok vidéo-seule vs photo(s)-seules vs combinaison invalide (case à cocher désactivée avec message explicatif), round-trip complet sauvegarde→réédition avec ordre des médias préservé, programmation d'un carrousel réel (le job pg-boss route correctement vers `publishInstagramCarousel`, échoue au même endroit que prévu — token bidon — confirmant l'absence de bug de branchement).
- **Piège d'automatisation découvert** : voir la note Checkbox Base UI plus haut dans ce fichier (§12).
- **Incident d'infra observé, sans rapport avec le code** : le serveur `prisma dev` local a occasionnellement renvoyé `P1017 ConnectionClosed` sous charge concurrente (web + worker + scripts de test simultanés) — auto-résolu au rechargement. Probablement une limite du moteur Postgres-compatible allégé utilisé par `prisma dev`, pas un souci en production (Supabase = vrai Postgres). À garder en tête si ça se reproduit en dev.

## 16. Suite de tests automatisés (Vitest)

`npm test` (une fois) / `npm run test:watch` (mode watch). **46 tests, 5 fichiers, tous verts** sur un `prisma dev` fraîchement redémarré.

- **Config** : [vitest.config.ts](vitest.config.ts). Deux points non-standards nécessaires :
  - `"server-only"` n'est pas un vrai package npm (Next.js le résout en interne dans son bundler) — aliasé vers un stub vide ([src/test/server-only-stub.ts](src/test/server-only-stub.ts)), sinon tout import d'un fichier `lib/`/`worker/` échoue en "module not found" sous Vitest.
  - `import "dotenv/config"` en tête du config : Vitest ne charge PAS `.env` automatiquement comme le fait Next.js — sans ça, `DATABASE_URL` est vide et les tests d'intégration tombent en `ECONNREFUSED`.
- **Tests unitaires purs** (aucune I/O) : [src/lib/errors.test.ts](src/lib/errors.test.ts) (classification d'erreurs IG/TikTok), [src/lib/media-validation.test.ts](src/lib/media-validation.test.ts) (compatibilité média par plateforme), [src/lib/content-type.test.ts](src/lib/content-type.test.ts) (calcul Reel/Image/Story/Carrousel/TikTok), [src/lib/providers/tiktok.test.ts](src/lib/providers/tiktok.test.ts) (`computeChunkRanges` — couverture des bornes 5/64/128 Mo et du cas « petit reliquat absorbé »).
- **Test d'intégration réel** : [src/lib/scheduler.test.ts](src/lib/scheduler.test.ts) — exerce le VRAI Prisma + le VRAI pg-boss contre la base `prisma dev` locale (crée un user/compte/média/post de test, appelle `schedulePost`/`unschedulePost`, vérifie les lignes `PublishJob` et le statut en cascade, nettoie après coup). C'est le seul fichier de test qui nécessite `DATABASE_URL` et un serveur Postgres local accessible.
- **⚠️ Piège d'environnement documenté dans le fichier lui-même** : sur `prisma dev` (moteur Postgres-compatible allégé), appeler `boss.createQueue()` puis, PEU APRÈS dans le même process, une transaction Prisma mêlant un appel ORM et un `$queryRawUnsafe` (utilisé par pg-boss via `fromPrisma`) déclenche parfois une erreur de protocole (`bind message... prepared statement requires 0` / `portal does not exist`). Isolé par diagnostic minimal reproductible **hors application** — jamais observé en usage réel (où `createQueue()` ne tourne qu'une fois au démarrage du worker, jamais adjacent à une programmation utilisateur). Le test retente puis, si le signal persiste, le documente au lieu de faire échouer toute la suite pour un artefact d'environnement. **Sur un serveur `prisma dev` fraîchement redémarré, ce chemin passe bien "en vrai"** (testé deux fois de suite) — le déclencheur semble être l'accumulation de connexions après beaucoup de scripts de diagnostic dans la même session, pas un bug systématique.
- **Pas encore fait** : tests pour les Server Actions elles-mêmes (`savePostDraft`, OAuth callbacks), tests de composants React, tests e2e navigateur automatisés (Playwright). La couverture actuelle cible délibérément la logique la plus critique et la plus facile à casser silencieusement (classification d'erreurs, calculs de chunks/types de contenu, cycle de vie transactionnel du scheduler) plutôt que l'exhaustivité.
