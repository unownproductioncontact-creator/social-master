import type { NextConfig } from "next";

// En-têtes de sécurité de base (audit du 09/07/2026, voir la mission qui a introduit ce bloc) —
// PAS de Content-Security-Policy pour l'instant : Next.js 16 + notre code (Server Actions/
// Route Handlers) ne posent pas d'inline scripts qu'on maîtrise directement, mais l'overlay Dev
// Tools et l'hydratation React 19 utilisent des mécanismes internes qu'une CSP stricte (sans
// 'unsafe-inline'/nonce câblé partout) casserait probablement sans qu'on ait audité chaque page.
// Une CSP correcte demande un vrai chantier dédié (nonces par requête, script-src précis) — à
// traiter plus tard, pas dans ce lot d'en-têtes "sûrs par défaut" qui ne peuvent rien casser.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Render sert déjà l'app en HTTPS-only (TLS géré par la plateforme, pas de HTTP en amont) —
  // l'en-tête reste donc correct à poser nous-mêmes. Pas de `preload` (implique une soumission à
  // la liste de préchargement HSTS des navigateurs, hors sujet ici et pas demandé).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Proxy public des médias R2 (voir src/lib/storage.ts et CLAUDE.md §3) : les fichiers
        // servis ici viennent des uploads utilisateur, donc jamais exécutés/interprétés par le
        // navigateur (nosniff déjà couvert ci-dessus par le matcher global, répété ici pour rendre
        // l'intention explicite sur cette route précise) et affichés inline (pas de
        // téléchargement forcé — Instagram/TikTok/l'aperçu navigateur doivent pouvoir les lire
        // directement).
        source: "/api/m/:path*",
        headers: [
          { key: "Content-Disposition", value: "inline" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
