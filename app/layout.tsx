import type { Metadata, Viewport } from "next";
import "./globals.css";
import { auth } from "@/auth";
import Providers from "@/components/Providers";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Stash",
  description: "Track expenses, budget, and net worth",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Stash",
  },
  icons: {
    icon: { url: "/favicon.svg", type: "image/svg+xml" },
    apple: "/icons/apple-touch-icon.png",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolving the session here and seeding SessionProvider with it means
  // useSession() is populated on the very first client render — no extra
  // /api/auth/session round trip, and cache readers can key by user id
  // synchronously instead of waiting a tick and flashing empty.
  const session = await auth();

  return (
    <html lang="en">
      <body className="min-h-screen bg-charcoal">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
