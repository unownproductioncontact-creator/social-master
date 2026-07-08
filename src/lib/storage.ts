import "server-only";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { appUrl } from "@/lib/app-url";

function getClient(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("Variables R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY manquantes");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Les versions récentes du SDK v3 calculent par défaut un checksum (x-amz-checksum-crc32,
    // requestChecksumCalculation: "WHEN_SUPPORTED") que Cloudflare R2 ne gère pas correctement
    // sur les URLs présignées — la requête PUT échoue silencieusement côté navigateur
    // (fetch()/XHR lèvent une erreur réseau, sans code HTTP exploitable). Constaté en prod le
    // 08/07/2026. Correctif standard R2 : revenir à l'ancien comportement (checksum uniquement
    // si explicitement requis par l'opération).
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET manquant");
  return bucket;
}

/** URL présignée pour un upload direct navigateur → R2 (PUT), valide 10 minutes. */
export async function createPresignedUploadUrl(key: string, contentType: string): Promise<string> {
  const client = getClient();
  const command = new PutObjectCommand({ Bucket: getBucket(), Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: 600 });
}

/** Stream brut d'un objet R2, pour la route proxy /api/m/[...key] (jamais bufferisé en RAM). */
export async function getObjectStream(key: string, range?: string) {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key, Range: range });
  return client.send(command);
}

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

/** Bufferise un objet entier en RAM — réservé aux petits fichiers (images). Ne jamais utiliser pour des vidéos. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const object = await getObjectStream(key);
  if (!object.Body) throw new Error(`Objet R2 introuvable : ${key}`);
  const bytes = await object.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function putObjectBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = getClient();
  await client.send(new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function objectExists(key: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.send(new GetObjectCommand({ Bucket: getBucket(), Key: key, Range: "bytes=0-0" }));
    return true;
  } catch {
    return false;
  }
}

export function buildStorageKey(userId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const uniquePrefix = crypto.randomUUID();
  return `media/${userId}/${uniquePrefix}-${safeName}`;
}

/** URL publique servie par notre propre proxy (pas de domaine custom R2 disponible — voir CLAUDE.md §3). */
export function getPublicMediaUrl(key: string): string {
  return `${appUrl()}/api/m/${key}`;
}
