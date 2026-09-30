import "server-only";
import { findClient } from "@/lib/mcp/oauth-store";

/**
 * Validation d'une demande d'autorisation (/oauth/authorize), partagée par la page de consentement et
 * les server actions qui la traitent (jamais de confiance dans les champs cachés du formulaire).
 * - `fatal` : client ou redirect_uri non fiables → on affiche l'erreur, on ne redirige JAMAIS.
 * - `redirectError` : demande mal formée mais redirect_uri de confiance → retour au client avec error.
 */
export type AuthorizeParams = {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
};

export type AuthorizeValidation =
  | { ok: true; clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state?: string }
  | { ok: false; fatal: string }
  | { ok: false; redirectUri: string; state?: string; redirectError: string };

export async function validateAuthorizeRequest(params: AuthorizeParams): Promise<AuthorizeValidation> {
  if (!params.client_id) return { ok: false, fatal: "Demande incomplète : client_id manquant." };
  const client = await findClient(params.client_id);
  if (!client) return { ok: false, fatal: "Application inconnue. Supprimez puis ré-ajoutez le connecteur dans Claude." };
  if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) {
    return { ok: false, fatal: "Adresse de retour non autorisée pour cette application." };
  }
  const back = { redirectUri: params.redirect_uri, state: params.state };
  if (params.response_type !== "code") return { ok: false, ...back, redirectError: "unsupported_response_type" };
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return { ok: false, ...back, redirectError: "invalid_request" };
  }
  return {
    ok: true,
    clientId: client.id,
    clientName: client.name,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    state: params.state,
  };
}

/** Lit les paramètres d'autorisation depuis les champs d'un formulaire de consentement. */
export function authorizeParamsFromForm(formData: FormData): AuthorizeParams {
  const get = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    response_type: get("response_type"),
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    state: get("state"),
  };
}
