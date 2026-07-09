import { getCurrentUser } from "@/lib/dal";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenu } from "@/components/layout/user-menu";
import { MobileHeader } from "@/components/layout/mobile-header";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="hidden w-64 flex-col border-r bg-muted/20 lg:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="bg-brand-gradient size-6 shrink-0 rounded-md" aria-hidden="true" />
          <span className="text-base font-semibold">Social Master</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
        {user && <UserMenu name={user.name} email={user.email} />}
      </aside>
      <MobileHeader user={user ? { name: user.name, email: user.email } : null} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
