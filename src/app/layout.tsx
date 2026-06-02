import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "STR Operations",
  description: "Short-term rental operations app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning on <html> and <body> tolerates
  // attribute differences injected by browser extensions, iOS
  // Safari (which sometimes adds Apple-data-* attributes
  // post-load), or any HTTPS tunnel proxy that decorates the
  // response. Without this, those benign external changes
  // trigger the "tree hydrated but attributes didn't match" dev
  // overlay — the overlay blocks tapping on mobile and makes
  // testing impossible.
  //
  // We deliberately do NOT suppress on inner elements — those
  // mismatches would be real bugs in our own code.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
