import type { NextConfig } from "next";

const enableClipper = process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER === "1" || process.env.ENABLE_WEB_CLIPPER === "1";
const nextConfig: NextConfig = {
  async redirects() {
    if (enableClipper) return [];
    // Web clipper disabled (Electron-only): redirect only clipper-specific routes.
    // Account/auth routes remain accessible — otherwise /app/login and /account→/app/profile loop (307).
    return [
      { source: "/app", destination: "/account", permanent: false },
      { source: "/app/dashboard", destination: "/account", permanent: false },
      { source: "/app/dashboard/:path*", destination: "/account", permanent: false },
      { source: "/app/projects", destination: "/account", permanent: false },
      { source: "/app/projects/:path*", destination: "/account", permanent: false },
    ];
  },
};

export default nextConfig;
