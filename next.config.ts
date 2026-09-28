import type { NextConfig } from "next";

// Security headers on every response. The app holds tax IDs, SSNs and client
// documents, so the browser is told to be as strict as the app allows:
//
//   HSTS                     HTTPS only, for two years, subdomains included.
//   frame-ancestors / XFO    Nothing may frame the app (clickjacking).
//   nosniff                  Browsers use the declared content type, never guess.
//   Referrer-Policy          no-referrer: client request links (/r/<token>)
//                            carry their credential in the URL, and nothing
//                            the app links to should ever see it.
//   Permissions-Policy       No camera, mic, location, payment, USB etc.
//   COOP                     Other sites' windows can't script this one.
//   base-uri / form-action / object-src
//                            Blocks the injection tricks that don't need a
//                            script: a rewritten <base>, a form posting data
//                            off-site, a plugin object.
//
// script-src is deliberately not set here: a strict script policy needs a
// per-request nonce threaded through the app (see node_modules/next/dist/docs/
// 01-app/02-guides/content-security-policy.md), which is a separate change.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework and version to scanners.
  poweredByHeader: false,
  // The dev-only route indicator defaults to bottom-left, where it sits on
  // top of the sidebar's "Sign out" button. Bottom-right is over page
  // gutter instead.
  devIndicators: {
    position: "bottom-right",
  },
  experimental: {
    // The Files tab uploads documents through a Server Action; the default
    // request body cap is 1 MB, which is too small for real PDFs/scans.
    serverActions: {
      bodySizeLimit: "15mb",
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // File downloads get a stricter CSP than pages: nothing may load or run
        // at all, even if a browser ignored the attachment disposition. Listed
        // after the catch-all because config headers override route headers
        // and the last match for a key wins.
        source: "/api/documents/:path*",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; sandbox" }],
      },
      {
        // Client request pages: never cached by a shared proxy or the browser's
        // back/forward cache, never indexed.
        source: "/r/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
