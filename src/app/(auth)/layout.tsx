export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 px-4">
      <div className="bg-brand-gradient flex size-10 items-center justify-center rounded-xl" aria-hidden="true">
        <span className="text-sm font-semibold text-primary-foreground">SM</span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
