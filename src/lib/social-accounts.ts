// Plusieurs comptes par réseau (CLAUDE.md §44) : règles PURES partagées par le composer (client), la
// création des posts, le connecteur Claude et les pages. Aucun accès base ici.

export const ACCOUNT_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "FACEBOOK"] as const;
export type AccountPlatform = (typeof ACCOUNT_PLATFORMS)[number];

export type AccountLike = {
  id: string;
  platform: string;
  username: string;
  label: string | null;
  createdAt: Date;
};

const PLATFORM_NAMES: Record<AccountPlatform, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  YOUTUBE: "YouTube",
  FACEBOOK: "Facebook",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform as AccountPlatform] ?? platform;
}

/**
 * Comptes d'un réseau, le PRINCIPAL d'abord : le plus ancien connecté (une reconnexion garde la même ligne,
 * donc sa place). Ordre stable : à date égale, l'identifiant départage.
 */
export function accountsOf<T extends AccountLike>(accounts: readonly T[], platform: string): T[] {
  return accounts
    .filter((a) => a.platform === platform)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

export function principalAccount<T extends AccountLike>(accounts: readonly T[], platform: string): T | undefined {
  return accountsOf(accounts, platform)[0];
}

/** Nom affiché : le nom donné par l'utilisateur, sinon @pseudo (ou le nom de la Page Facebook). */
export function accountDisplayName(account: Pick<AccountLike, "label" | "username" | "platform">): string {
  const label = account.label?.trim();
  if (label) return label;
  return account.platform === "FACEBOOK" ? account.username : `@${account.username}`;
}

/** Nom complet pour une liste : « Clips (@pokemoha_clips) ». */
export function accountFullName(account: Pick<AccountLike, "label" | "username" | "platform">): string {
  const label = account.label?.trim();
  const handle = account.platform === "FACEBOOK" ? account.username : `@${account.username}`;
  return label ? `${label} (${handle})` : handle;
}

const normalize = (s: string) =>
  s
    .trim()
    .replace(/^@/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Compte désigné par l'utilisateur (connecteur : « clips », « @pokemoha_clips », un identifiant) parmi les
 * comptes d'un réseau : nom donné, pseudo ou identifiant, sans accents ni casse. « principal » = le compte
 * principal. undefined si rien ne correspond.
 */
export function matchAccountRef<T extends AccountLike>(accounts: readonly T[], platform: string, ref: string): T | undefined {
  const list = accountsOf(accounts, platform);
  const wanted = normalize(ref);
  if (!wanted) return undefined;
  return (
    list.find((a) => a.id === ref.trim()) ??
    list.find((a) => a.label && normalize(a.label) === wanted) ??
    list.find((a) => normalize(a.username) === wanted) ??
    (wanted === "principal" || wanted === "principale" ? list[0] : undefined)
  );
}

export type AccountChoice = {
  /** Identifiant choisi explicitement (composer) ; null = le principal. */
  accountId?: string | null;
  /** Nom ou pseudo donné par le connecteur ; null = le principal. */
  accountRef?: string | null;
  /** Compte de la cible actuelle quand on modifie un brouillon (gardé si rien n'est précisé). */
  previousAccountId?: string | null;
};

/**
 * Compte d'une cible : choix explicite (identifiant, puis nom) > compte déjà utilisé par le brouillon >
 * compte principal. Une désignation qui ne correspond à rien est une ERREUR (jamais de repli silencieux
 * sur un autre compte : publier sur la mauvaise chaîne est pire que refuser).
 */
export function resolveAccount<T extends AccountLike>(
  accounts: readonly T[],
  platform: string,
  choice: AccountChoice
): { account: T } | { error: string } {
  const list = accountsOf(accounts, platform);
  if (list.length === 0) {
    return { error: platform === "FACEBOOK" ? "Connectez d'abord votre Page Facebook." : `Connectez d'abord votre compte ${platformName(platform)}.` };
  }
  const available = () => list.map(accountFullName).join(", ");

  if (choice.accountId !== undefined) {
    if (choice.accountId === null) return { account: list[0] };
    const account = list.find((a) => a.id === choice.accountId);
    return account ? { account } : { error: `Compte ${platformName(platform)} introuvable. Comptes connectés : ${available()}.` };
  }
  if (choice.accountRef !== undefined) {
    if (choice.accountRef === null) return { account: list[0] };
    const account = matchAccountRef(accounts, platform, choice.accountRef);
    return account
      ? { account }
      : { error: `Aucun compte ${platformName(platform)} « ${choice.accountRef} ». Comptes connectés : ${available()}.` };
  }
  const previous = choice.previousAccountId ? list.find((a) => a.id === choice.previousAccountId) : undefined;
  return { account: previous ?? list[0] };
}

/** Nom donné à un compte : nettoyé, 40 caractères au plus, vide = pas de nom. */
export function cleanAccountLabel(raw: string | null | undefined): string | null {
  const label = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || null;
}

export type AccountChoices = Partial<Record<AccountPlatform, Array<{ id: string; name: string }>>>;

/** Comptes proposés dans le composer, par réseau, le principal d'abord (nom complet : « Clips (@pseudo) »). */
export function accountChoicesFrom(accounts: readonly AccountLike[]): AccountChoices {
  const choices: AccountChoices = {};
  for (const platform of ACCOUNT_PLATFORMS) {
    const list = accountsOf(accounts, platform);
    if (list.length > 0) choices[platform] = list.map((a) => ({ id: a.id, name: accountFullName(a) }));
  }
  return choices;
}
