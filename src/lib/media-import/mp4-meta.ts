/**
 * Métadonnées d'une vidéo MP4/MOV (ISO-BMFF) SANS la télécharger entièrement (CLAUDE.md §30) : on
 * parcourt les boîtes de premier niveau par petites lectures pour trouver `moov` (au début si
 * « faststart », sinon à la fin), puis on y lit la durée (`mvhd`) et les dimensions de la piste vidéo
 * (`tkhd` d'une piste dont `hdlr` = « vide »), en appliquant la rotation de la matrice d'affichage
 * (vidéos de téléphone filmées en portrait : codées en paysage + rotation 90°). PUR (lecteur injecté).
 */
export type ByteReader = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type VideoMeta = { durationSec: number | null; width: number | null; height: number | null };

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 256;

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function i32(b: Uint8Array, o: number): number {
  return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}

function type(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

type Box = { type: string; start: number; payload: number; end: number };

/** Boîtes enfants contenues dans [from, to) d'un buffer déjà lu. */
function childBoxes(b: Uint8Array, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < header || o + size > to) break;
    boxes.push({ type: type(b, o + 4), start: o, payload: o + header, end: o + size });
    o += size;
  }
  return boxes;
}

function find(b: Uint8Array, parent: Box, name: string): Box | undefined {
  return childBoxes(b, parent.payload, parent.end).find((c) => c.type === name);
}

/** Localise `moov` parmi les boîtes de premier niveau du fichier, par lectures d'en-têtes de 16 octets. */
async function locateMoov(reader: ByteReader): Promise<{ offset: number; size: number } | null> {
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset + 8 <= reader.size; i++) {
    const h = await reader.read(offset, Math.min(16, reader.size - offset));
    if (h.length < 8) return null;
    let size = u32(h, 0);
    if (size === 1) {
      if (h.length < 16) return null;
      size = u64(h, 8);
    } else if (size === 0) {
      size = reader.size - offset;
    }
    if (size < 8) return null;
    if (type(h, 4) === "moov") return { offset, size };
    offset += size;
  }
  return null;
}

export async function parseVideoMeta(reader: ByteReader): Promise<VideoMeta> {
  const empty: VideoMeta = { durationSec: null, width: null, height: null };
  const loc = await locateMoov(reader);
  if (!loc || loc.size > MAX_MOOV_BYTES) return empty;
  const b = await reader.read(loc.offset, loc.size);
  const moov: Box = { type: "moov", start: 0, payload: 8, end: b.length };
  if (u32(b, 0) === 1) moov.payload = 16;

  let durationSec: number | null = null;
  const mvhd = find(b, moov, "mvhd");
  if (mvhd) {
    const p = mvhd.payload;
    const v1 = b[p] === 1;
    const timescale = v1 ? u32(b, p + 20) : u32(b, p + 12);
    const duration = v1 ? u64(b, p + 24) : u32(b, p + 16);
    if (timescale > 0) durationSec = Math.round((duration / timescale) * 1000) / 1000;
  }

  for (const trak of childBoxes(b, moov.payload, moov.end).filter((c) => c.type === "trak")) {
    const mdia = find(b, trak, "mdia");
    const hdlr = mdia && find(b, mdia, "hdlr");
    if (!hdlr || type(b, hdlr.payload + 8) !== "vide") continue;
    const tkhd = find(b, trak, "tkhd");
    if (!tkhd) continue;
    const p = tkhd.payload;
    const v1 = b[p] === 1;
    const matrix = p + (v1 ? 52 : 40);
    const width = Math.round(u32(b, matrix + 36) / 65536);
    const height = Math.round(u32(b, matrix + 40) / 65536);
    // Matrice [a b u / c d v / x y w] : rotation de 90° ou 270° ⇔ a = d = 0 → dimensions affichées inversées.
    const a = i32(b, matrix);
    const d = i32(b, matrix + 16);
    const rotated = a === 0 && d === 0;
    if (width > 0 && height > 0) {
      return { durationSec, width: rotated ? height : width, height: rotated ? width : height };
    }
  }
  return { durationSec, width: null, height: null };
}
