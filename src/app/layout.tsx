import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SidebarNav } from "@/components/sidebar-nav";
import { getCurrentUser } from "@/lib/auth";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Workflow Dashboard",
  description: "Client project tracking for the firm",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // proxy.ts guarantees the only user-less routes that reach here are /login
  // and /invite/*; those render bare (no sidebar). Everything else has a user.
  const user = await getCurrentUser();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-background text-ink">
        {user ? (
          <>
            <SidebarNav user={user} />
            <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
          </>
        ) : (
          <main className="min-w-0 flex-1">{children}</main>
        )}
      </body>
    </html>
  );
}
