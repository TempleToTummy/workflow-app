import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The Files tab uploads documents through a Server Action; the default
    // request body cap is 1 MB, which is too small for real PDFs/scans.
    serverActions: {
      bodySizeLimit: "15mb",
    },
  },
};

export default nextConfig;
