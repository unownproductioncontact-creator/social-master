/**
 * Détection du type réel d'un fichier par ses premiers octets (« magic bytes ») : on ne fait jamais
 * confiance au Content-Type annoncé (Drive renvoie souvent application/octet-stream). PUR, testé.
 */
export type ImportedMime = "video/mp4" | "video/quicktime" | "video/webm" | "image/jpeg" | "image/png" | "image/webp";

export const EXTENSION_FOR: Record<ImportedMime, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function sniffMediaType(b: Uint8Array): ImportedMime | null {
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") return ascii(b, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  // Ancien QuickTime sans ftyp : la première boîte est directement moov/mdat/wide/free.
  if (b.length >= 8 && ["moov", "mdat", "wide", "free", "skip"].includes(ascii(b, 4, 8))) return "video/quicktime";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Vrai si le « fichier » est en fait une page web (lien non public, page de connexion…). */
export function looksLikeHtml(b: Uint8Array): boolean {
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<");
}

/** Nom de fichier d'un en-tête Content-Disposition (filename* RFC 5987 prioritaire), sinon null. */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // encodage invalide : on retombe sur filename=
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/);
  const name = plain?.[1] ?? plain?.[2]?.trim();
  return name || null;
}

/** Nom final : celui fourni, sinon celui du serveur, sinon un nom daté ; extension forcée sur le vrai type. */
export function finalFileName(candidates: Array<string | null | undefined>, mime: ImportedMime, now: Date): string {
  const base =
    candidates.map((c) => c?.trim()).find((c): c is string => Boolean(c)) ?? `import-${now.toISOString().slice(0, 10)}`;
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 80) || "import";
  return `${stem}.${EXTENSION_FOR[mime]}`;
}
