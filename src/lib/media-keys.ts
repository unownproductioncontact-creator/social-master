/**
 * Clés R2 d'un média : l'original, sa miniature et la copie JPEG pour Instagram. Module PUR, source
 * unique des conventions de nommage — la création (route miniature, `ensureJpegVersion`) ET la
 * suppression (`deleteMediaAssetForUser`, balayage des orphelins) passent par ici : un objet dérivé
 * dont la clé n'est connue que de celui qui l'a créé finit forcément en fuite de stockage
 * (CLAUDE.md §36 : les copies `.converted.jpg` n'étaient jamais supprimées).
 */

const CONVERTED_JPEG_SUFFIX = ".converted.jpg";
const THUMBNAIL_SUFFIX = ".thumb.jpg";

/** Copie JPEG d'une image PNG/WebP, créée à la volée pour Instagram (`ensureJpegVersion`). */
export function convertedJpegKey(storageKey: string): string {
  return `${storageKey}${CONVERTED_JPEG_SUFFIX}`;
}

/** Miniature JPEG d'une vidéo, envoyée par le navigateur après l'upload (route /thumbnail). */
export function thumbnailKeyFor(storageKey: string): string {
  return `${storageKey}${THUMBNAIL_SUFFIX}`;
}

/**
 * Toutes les clés R2 que ce média peut avoir fait naître, sans doublon. Les clés dérivées sont
 * déterministes : on les inclut même quand la base ne les connaît pas (miniature envoyée mais ligne
 * jamais mise à jour, copie JPEG créée par une publication).
 */
export function objectKeysOfAsset(asset: { storageKey: string; thumbnailKey?: string | null }): string[] {
  const keys = [asset.storageKey, asset.thumbnailKey, thumbnailKeyFor(asset.storageKey), convertedJpegKey(asset.storageKey)];
  return [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
}

/** Ensemble des clés que la base référence (médias de tous les utilisateurs, quel que soit leur statut). */
export function referencedObjectKeys(assets: Array<{ storageKey: string; thumbnailKey?: string | null }>): Set<string> {
  const keys = new Set<string>();
  for (const asset of assets) for (const key of objectKeysOfAsset(asset)) keys.add(key);
  return keys;
}
