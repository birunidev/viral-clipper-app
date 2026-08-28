import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/lib/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3005";

// Google Analytics 4 (gtag.js). Set NEXT_PUBLIC_GA_ID (e.g. "G-XXXXXXXXXX")
// to enable; unset/empty keeps the scripts out of the HTML entirely.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ClipZard — Turn long videos into viral short clips",
    template: "%s · ClipZard",
  },
  description:
    "Paste a YouTube link or upload a video. ClipZard transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
  applicationName: "ClipZard",
  keywords: [
    "video clips",
    "viral clips",
    "short clips",
    "TikTok clips",
    "Reels",
    "Shorts",
    "YouTube to TikTok",
    "AI video editor",
    "podcast clips",
  ],
  openGraph: {
    type: "website",
    siteName: "ClipZard",
    title: "ClipZard — Turn long videos into viral short clips",
    description:
      "Paste a YouTube link or upload a video. ClipZard transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
    url: SITE_URL,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ClipZard" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipZard — Turn long videos into viral short clips",
    description:
      "Paste a YouTube link or upload a video. ClipZard transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
    images: ["/og.png"],
  },
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
      {GA_ID && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_ID}');
            `}
          </Script>
        </>
      )}
    </html>
  );
}
