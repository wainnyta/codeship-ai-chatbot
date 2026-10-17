import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  IBM_Plex_Sans_Condensed,
  IBM_Plex_Serif,
} from "next/font/google";
import "./globals.css";

/**
 * One superfamily in four optical roles, so the faces harmonise while still
 * signalling what kind of text you are reading: sans for chrome, serif for
 * generated prose, mono for verbatim passages lifted out of the documents.
 *
 * The fourth is condensed, and it sets exactly one word. A wordmark should not
 * look like a piece of the interface it sits in, and in any of the other three it
 * looked like a heading that had wandered into the bar. Narrow, in caps, it reads
 * as a name — and being the same superfamily it still belongs to everything else.
 */
const sans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const serif = IBM_Plex_Serif({
  variable: "--font-plex-serif",
  subsets: ["latin"],
  weight: ["400", "600"],
});

const condensed = IBM_Plex_Sans_Condensed({
  variable: "--font-plex-condensed",
  subsets: ["latin"],
  weight: ["600"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "NimbusStack Product Assistant",
  description: "Answers about NimbusStack products, drawn only from NimbusStack's own documentation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable} ${condensed.variable}`}>
      <body>{children}</body>
    </html>
  );
}
