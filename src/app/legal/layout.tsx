import Link from "next/link";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Retour à Social Master
      </Link>
      <div className="mt-6 space-y-4 text-sm leading-relaxed [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_p]:text-muted-foreground [&_li]:text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
