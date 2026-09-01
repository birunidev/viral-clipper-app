import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_CLIPPER = process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER === "1" || process.env.ENABLE_WEB_CLIPPER === "1";

// Routes that must stay accessible even when web clipper is Electron-only.
// Auth + account management should not redirect, otherwise /app/login → /account and /account→/app/profile loop.
const PUBLIC_AUTH = new Set([
  "/app/login",
  "/app/register",
  "/app/forgot-password",
  "/app/reset-password",
  "/app/accept-terms",
  "/app/profile",
  "/app/billing",
  "/app/licenses",
  "/app/settings",
]);

export function middleware(request: NextRequest) {
  if (PUBLIC_CLIPPER) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (PUBLIC_AUTH.has(pathname)) return NextResponse.next();
  // Only clipper-specific app routes redirect to /account when disabled.
  const isClipperRoute =
    pathname === "/app" ||
    pathname.startsWith("/app/dashboard") ||
    pathname.startsWith("/app/projects");
  if (isClipperRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/account";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/admin/:path*"],
};
