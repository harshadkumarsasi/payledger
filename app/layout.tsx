import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "PayLedger — idempotent payments demo",
  description:
    "A miniature payments core with idempotent transfers, concurrency-safe balances, and a double-entry ledger.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
