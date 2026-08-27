import type { NextConfig } from "next";

const enableClipper = process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER === "1" || process.env.ENABLE_WEB_CLIPPER === "1";
const nextConfig: NextConfig = {
  async redirects() {
    if (enableClipper) return [];
    return [{ source: "/app/:path*", destination: "/account", permanent: false }];
  },
};

export default nextConfig;
