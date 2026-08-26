import type { Metadata } from "next";
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

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "BandarClip — Turn long videos into viral short clips",
    template: "%s · BandarClip",
  },
  description:
    "Paste a YouTube link or upload a video. BandarClip transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
  applicationName: "BandarClip",
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
    siteName: "BandarClip",
    title: "BandarClip — Turn long videos into viral short clips",
    description:
      "Paste a YouTube link or upload a video. BandarClip transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
    url: SITE_URL,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "BandarClip" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "BandarClip — Turn long videos into viral short clips",
    description:
      "Paste a YouTube link or upload a video. BandarClip transcribes it, finds the moments that hook, and cuts them to 9:16 — automatically.",
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
    </html>
  );
}
