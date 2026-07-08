import "server-only";

/**
 * Base de l'application (depuis APP_URL), garantie SANS slash final.
 *
 * Vécu le 08/07/2026 : si la variable Render `APP_URL` se termine par « / »
 * (ex. `https://…onrender.com/`), un `${APP_URL}/api/...` produit un double
 * slash (`…com//api/...`). TikTok rejette alors l'OAuth avec « redirect_uri »
 * (mismatch exact avec l'URI enregistrée). On normalise ici une fois pour
 * toutes les URLs construites (callbacks OAuth Instagram/TikTok, proxy média).
 */
export function appUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/+$/, "");
}
