import { NextResponse, type NextRequest } from "next/server";

// Coarse auth gate: is there a session cookie, and is this a public path? Real
// enforcement (valid session, correct role) happens in src/lib/auth.ts via
// requireUser()/requireAdmin() in pages, src/app/admin/layout.tsx, and every
// server action — this just keeps logged-out visitors out of the app shell.
//
// In Next 16 the `middleware` file convention is renamed to `proxy` and runs on
// the Node.js runtime by default.

const SESSION_COOKIE = "wf_session";
const PUBLIC_PREFIXES = ["/login", "/invite", "/forgot-password", "/reset-password"];

// Machine-callable endpoints. A scheduler has no session cookie, so bouncing
// it to /login would break the nightly job; the same is true of the mail
// provider posting an inbound reply. These authenticate themselves in the
// route handler instead (bearer token or webhook signature, or an admin
// session for the "Run now" button). Keep this list to routes that do their
// own auth.
const MACHINE_PREFIXES = ["/api/cron", "/api/email/inbound"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    MACHINE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Bouncing an already-signed-in user off /login is deliberately NOT done
  // here. This gate only knows whether a cookie exists, not whether its
  // session is still valid, and a cookie whose Session row is gone (deleted,
  // or simply expired) would bounce /login → / while requireUser() on the page
  // bounces / → /login — an infinite redirect that locks the user out with no
  // way back to the sign-in form. The login page does that redirect instead,
  // where the session can actually be verified. See src/app/login/page.tsx.
  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static asset files. API routes are
  // included so unauthenticated file downloads get bounced too (the route
  // handler also checks).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
