import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "ContextDJ - AI Music Curator",
  description: "Your personalized AI DJ that plays the perfect music for your context.",
  manifest: `${basePath}/manifest.json`,
  metadataBase: new URL(appUrl),
  openGraph: {
    title: "ContextDJ - AI Music Curator",
    description: "Your personalized AI DJ that plays the perfect music for your context.",
    type: "website",
    locale: "ja_JP",
    url: appUrl,
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
import ServiceWorkerRegister from '../components/ServiceWorkerRegister';

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
          <ServiceWorkerRegister />
        </PlayerProvider>
      </body>
    </html>
  );
}
