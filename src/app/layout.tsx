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
  // iOS Safari auto-detects strings that look like phone numbers,
  // dates, and addresses and wraps them in <a> tags AFTER the
  // server HTML arrives but BEFORE React hydrates. That DOM
  // mutation is the cause of the iPhone-only "tree hydrated but
  // attributes didn't match" overlay — our dashboard is full of
  // triggers ("2026/06/01, 21:41", "3 bedrooms", "started 27 min
  // ago"). Desktop browsers don't do this, which is why the
  // overlay only appeared on iPhone.
  //
  // format-detection disables every flavour of that auto-linking.
  // We don't rely on Safari's tel: linking anywhere — the WhatsApp
  // / phone affordances we build use explicit hrefs.
  formatDetection: {
    telephone: false,
    date: false,
    address: false,
    email: false,
  },
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
