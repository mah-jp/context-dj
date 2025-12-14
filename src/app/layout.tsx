import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "ContextDJ - AI Music Curator",
  description: "Your personalized AI DJ that plays the perfect music for your context.",
  manifest: `${basePath}/manifest.json`,
  metadataBase: new URL("https://contextdj.remoteroom.jp"),
  openGraph: {
    title: "ContextDJ - AI Music Curator",
    description: "Your personalized AI DJ that plays the perfect music for your context.",
    type: "website",
    locale: "ja_JP",
    url: "https://contextdj.remoteroom.jp",
    siteName: "ContextDJ",
    images: '/icon-512x512.png',
  },
  twitter: {
    card: "summary_large_image",
    title: "ContextDJ - AI Music Curator",
    description: "Your personalized AI DJ that plays the perfect music for your context.",
    creator: "@mah_jp",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

import { PlayerProvider } from '../context/PlayerContext';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <PlayerProvider>
          {children}
        </PlayerProvider>
      </body>
    </html>
  );
}
