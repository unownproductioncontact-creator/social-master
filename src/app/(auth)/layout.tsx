import { BrandMark } from "@/components/layout/brand-mark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4">
      <BrandMark />
      <div className="w-full max-w-[380px]">{children}</div>
    </div>
  );
}
