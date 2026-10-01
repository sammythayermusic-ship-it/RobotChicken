import type { Metadata, Viewport } from "next";
import { Barlow, Bungee } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google, so
// the CSP's font-src 'self' holds). Both are SIL OFL.
const display = Bungee({ variable: "--font-bungee", subsets: ["latin"], weight: "400" });
const body = Barlow({ variable: "--font-barlow", subsets: ["latin"], weight: ["400", "600", "800"] });

export const metadata: Metadata = {
  title: { default: "COCKFIGHT", template: "%s · COCKFIGHT" },
  description: "1v1 robot-chicken fights in a neon junkyard pit, in the browser.",
  // Relative image URLs resolve against this (the playtest build links the live site's card, which is fine).
  metadataBase: new URL("https://cockfightsol.fun"),
  openGraph: {
    type: "website",
    siteName: "COCKFIGHT",
    title: "COCKFIGHT · hold $COCK, get paid",
    description: "1v1 robot-chicken fights in the browser. Hold $COCK to play ranked; winners get paid.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "COCKFIGHT: hold $COCK, get paid" }],
  },
  twitter: { card: "summary_large_image", site: "@CockFightSol", images: ["/og.png"] },
};

export const viewport: Viewport = {
  themeColor: "#0a0710",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} antialiased`}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
