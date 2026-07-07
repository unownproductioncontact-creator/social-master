import "server-only";
import sharp from "sharp";
import { getObjectBuffer, putObjectBuffer, objectExists } from "@/lib/storage";

function jpegKeyFor(storageKey: string): string {
  return `${storageKey}.converted.jpg`;
}

/**
 * S'assure qu'une version JPEG de ce média existe sur R2 (Instagram n'accepte que le JPEG pour les
 * images). Convertit à la demande et met en cache sur une clé déterministe — les publications
 * suivantes du même média réutilisent le fichier déjà converti. Ne modifie jamais l'original.
 */
export async function ensureJpegVersion(storageKey: string, mimeType: string): Promise<string> {
  if (mimeType === "image/jpeg") return storageKey;

  const convertedKey = jpegKeyFor(storageKey);
  if (await objectExists(convertedKey)) return convertedKey;

  const original = await getObjectBuffer(storageKey);
  const jpegBuffer = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  await putObjectBuffer(convertedKey, jpegBuffer, "image/jpeg");

  return convertedKey;
}
