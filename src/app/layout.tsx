import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SidebarNav } from "@/components/sidebar-nav";
import { getCurrentUser } from "@/lib/auth";
import { unreadMentionCount } from "@/lib/comment-data";
import { runningTimer } from "@/lib/time-data";

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
  // proxy.ts guarantees the only user-less routes that reach here are the
  // public ones (/login, /invite/*, the password-reset pages, and /r/<token>
  // for clients); those render bare, with no sidebar. Everything else has a
  // user.
  const user = await getCurrentUser();

  // Two per-user badges that belong on every page: the unread mention count
  // and the running timer. Both are single indexed reads, and both are here
  // rather than on individual pages precisely because they have to be
  // reachable from wherever you happen to be — a timer you can only stop on
  // the page you started it from is how one gets left running all weekend.
  const [unreadMentions, timer] = user
    ? await Promise.all([unreadMentionCount(user.id), runningTimer(user.id)])
    : [0, null];

  return (
    <html
      lang="en"
      className={`${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-background text-ink">
        {user ? (
          <>
            <SidebarNav
              user={user}
              unreadMentions={unreadMentions}
              runningTimer={
                timer
                  ? {
                      startedAt: timer.startedAt.toISOString(),
                      label:
                        timer.activity?.subTask.name ??
                        timer.project?.name ??
                        timer.client?.companyName ??
                        "Internal time",
                      href:
                        timer.clientId && timer.projectId
                          ? `/assignments/${timer.clientId}/${timer.projectId}`
                          : null,
                    }
                  : null
              }
            />
            <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
          </>
        ) : (
          <main className="min-w-0 flex-1">{children}</main>
        )}
      </body>
    </html>
  );
}
