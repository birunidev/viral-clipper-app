import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3005";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // App shell requires auth; keep crawlers on public pages only.
        disallow: ["/app/dashboard", "/app/projects", "/app/billing", "/app/settings", "/app/accept-terms"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
