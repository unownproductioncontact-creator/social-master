import { logout } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut } from "lucide-react";

function initials(name: string | null | undefined, email: string) {
  const source = name?.trim() || email;
  return source.slice(0, 2).toUpperCase();
}

export function UserMenu({ name, email }: { name: string | null; email: string }) {
  return (
    <div className="flex items-center gap-2.5 border-t p-3">
      <Avatar className="size-[26px]">
        <AvatarFallback className="bg-accent-strong text-[10.5px] font-bold text-primary-strong">
          {initials(name, email)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-bold leading-tight">{name || email}</p>
        <p className="truncate text-[11px] leading-tight text-muted-foreground">{email}</p>
      </div>
      <form action={logout}>
        <Button type="submit" variant="ghost" size="icon-sm" title="Se déconnecter">
          <LogOut className="size-4" />
        </Button>
      </form>
    </div>
  );
}
