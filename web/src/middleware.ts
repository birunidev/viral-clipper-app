import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_CLIPPER = process.env.NEXT_PUBLIC_ENABLE_WEB_CLIPPER === "1" || process.env.ENABLE_WEB_CLIPPER === "1";

const PUBLIC_AUTH = new Set(["/app/login", "/app/register", "/app/accept-terms"]);

export function middleware(request: NextRequest) {
  if (PUBLIC_CLIPPER) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (PUBLIC_AUTH.has(pathname)) return NextResponse.next();
  if (pathname.startsWith("/app")) {
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
