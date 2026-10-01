/**
 * Lien de partage → URL de téléchargement direct (CLAUDE.md §30). PUR, testé.
 * Google Drive : fichier partagé « Tous les utilisateurs disposant du lien » ; on passe par
 * drive.usercontent.google.com avec confirm=t (évite la page d'avertissement des gros fichiers).
 * Dropbox : dl=1. Tout autre lien https est tenté tel quel (fichier direct).
 */
export type ShareLink =
  | { ok: true; provider: "google-drive" | "dropbox" | "direct"; downloadUrl: string }
  | { ok: false; error: string };

export function resolveShareLink(raw: string): ShareLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Lien invalide." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Seuls les liens https sont acceptés." };
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com" || host === "docs.google.com" || host === "drive.usercontent.google.com") {
    if (url.pathname.includes("/folders/")) {
      return { ok: false, error: "C'est un lien de DOSSIER Google Drive : partagez le lien du fichier vidéo lui-même." };
    }
    const id = url.pathname.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/)?.[1] ?? url.searchParams.get("id");
    if (!id || !/^[A-Za-z0-9_-]{10,}$/.test(id)) {
      return { ok: false, error: "Lien Google Drive non reconnu : utilisez « Partager → Copier le lien » sur le fichier." };
    }
    return {
      ok: true,
      provider: "google-drive",
      downloadUrl: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    };
  }

  if (host === "dropbox.com" || host === "www.dropbox.com") {
    if (url.pathname.startsWith("/scl/fo/") || url.pathname.startsWith("/sh/")) {
      return { ok: false, error: "C'est un lien de DOSSIER Dropbox : partagez le lien du fichier vidéo lui-même." };
    }
    url.searchParams.set("dl", "1");
    return { ok: true, provider: "dropbox", downloadUrl: url.toString() };
  }
  if (host === "dl.dropboxusercontent.com") return { ok: true, provider: "dropbox", downloadUrl: url.toString() };

  if (host === "icloud.com" || host === "www.icloud.com") {
    return { ok: false, error: "Les liens iCloud ne sont pas téléchargeables directement : utilisez Google Drive ou Dropbox." };
  }
  return { ok: true, provider: "direct", downloadUrl: url.toString() };
}
