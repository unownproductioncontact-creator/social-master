export const MEDIA_TYPES: Record<string, string>;
export const CONVERTIBLE_TO_JPEG: Set<string>;
export function allowedRoots(home: string, override?: string, extra?: Record<string, string>): Record<string, string>;
export function extraRootsFrom(config: unknown): Record<string, string>;
export function isInsideRoots(realFile: string, realRoots: string[]): boolean;
export function mediaKind(filePath: string): { mime: string } | { convert: true } | null;
export function pkcePair(): { verifier: string; challenge: string };
export function authorizeUrl(base: string, p: { clientId: string; redirectUri: string; challenge: string; state: string }): string;
export function sizeHints(mime: string, sizeBytes: number): string[];
