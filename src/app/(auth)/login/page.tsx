import { LoginForm } from "./login-form";

/** Page de connexion ; `?next=` (posé par le proxy) = page où revenir après connexion (ex. consentement OAuth). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === "string" ? next : undefined} />;
}
