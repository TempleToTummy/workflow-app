import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
