import { isIP } from "node:net";

/**
 * Anti-SSRF de l'import par lien (CLAUDE.md §30) : le serveur ne télécharge QUE depuis des adresses
 * publiques — jamais le réseau privé, la boucle locale, le link-local (ex. métadonnées cloud
 * 169.254.169.254), le CGNAT ni les plages réservées/multicast. PUR, testé.
 */
export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / métadonnées cloud
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // bancs d'essai
    if (a >= 224) return false; // multicast + réservé
    return true;
  }
  if (version === 6) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (v === "::" || v === "::1") return false;
    if (/^fe[89ab]/.test(v)) return false; // fe80::/10 link-local
    if (/^f[cd]/.test(v)) return false; // fc00::/7 ULA
    if (v.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}
