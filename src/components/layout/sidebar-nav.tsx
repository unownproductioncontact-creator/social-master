"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CalendarDays,
  SquarePen,
  Layers,
  Images,
  Link2,
  History,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/calendar", label: "Calendrier", icon: CalendarDays },
  { href: "/composer", label: "Créer un post", icon: SquarePen },
  { href: "/composer/bulk", label: "Publication en masse", icon: Layers },
  { href: "/library", label: "Médiathèque", icon: Images },
  { href: "/connections", label: "Connexions", icon: Link2 },
  { href: "/history", label: "Historique", icon: History },
  { href: "/settings", label: "Paramètres", icon: Settings },
];

/** Vrai si `pathname` est sous `href` (égal ou sous-chemin). */
function matchesHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  // Entrée active = celle dont le href correspond ET est le PLUS spécifique (le plus long) parmi
  // toutes celles qui correspondent. Sans ça, « /composer/bulk » activerait aussi « Créer un post »
  // (/composer), les deux étant préfixes du chemin. Le plus long préfixe gagne.
  const activeHref = NAV_ITEMS.filter((item) => matchesHref(pathname, item.href)).reduce<
    string | null
  >((best, item) => (best === null || item.href.length > best.length ? item.href : best), null);

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const isActive = item.href === activeHref;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-accent-strong text-primary-strong"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
