"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/insights", label: "Insights" },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="border-b border-white/10 bg-navy">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
        <div className="rounded-md bg-white p-1.5">
          <Image
            src="/razorpay-logo.svg"
            alt="Razorpay"
            width={104}
            height={22}
            priority
          />
        </div>
        <span className="h-5 w-px bg-navy-foreground/30" />
        <span className="text-sm font-medium text-navy-foreground/80">
          Revenue Recovery Agent
        </span>
        <nav className="ml-auto flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                pathname === link.href
                  ? "bg-white/10 text-navy-foreground"
                  : "text-navy-foreground/70 hover:text-navy-foreground"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
