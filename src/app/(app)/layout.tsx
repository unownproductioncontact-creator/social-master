import { getCurrentUser } from "@/lib/dal";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenu } from "@/components/layout/user-menu";
import { MobileHeader } from "@/components/layout/mobile-header";
import { BrandMark } from "@/components/layout/brand-mark";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="hidden w-56 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center px-4">
          <BrandMark />
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
        {user && <UserMenu name={user.name} email={user.email} />}
      </aside>
      <MobileHeader user={user ? { name: user.name, email: user.email } : null} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">{children}</div>
      </main>
    </div>
  );
}
