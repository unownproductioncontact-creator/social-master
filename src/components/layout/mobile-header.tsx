"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenu } from "@/components/layout/user-menu";
import { BrandMark } from "@/components/layout/brand-mark";

/**
 * En-tête mobile sticky (<lg) : pastille de marque + bouton hamburger
 * ouvrant un Sheet contenant la même navigation que la sidebar desktop.
 * Le layout ≥lg n'est pas affecté (ce header est caché via `lg:hidden`).
 */
export function MobileHeader({
  user,
}: {
  user: { name: string | null; email: string } | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background px-4 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Ouvrir le menu"
          onClick={() => setOpen(true)}
        >
          <Menu className="size-5" />
        </Button>
        <SheetContent side="left" className="max-w-56 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Menu de navigation</SheetTitle>
          </SheetHeader>
          <div className="flex h-14 items-center border-b px-4">
            <BrandMark />
          </div>
          <div className="flex-1 overflow-y-auto">
            <SidebarNav onNavigate={() => setOpen(false)} />
          </div>
          {user && <UserMenu name={user.name} email={user.email} />}
        </SheetContent>
      </Sheet>
      <BrandMark />
    </header>
  );
}
