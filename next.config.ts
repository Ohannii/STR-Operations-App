import type { NextConfig } from 'next'

/**
 * Next.js 16+ blocks cross-origin requests to the dev server's
 * internal assets (HMR pings, RSC payloads, server-action POSTs)
 * by default — only requests whose Host header matches one of
 * the listed origins are accepted. Without this list, opening
 * the app through a Cloudflare Quick Tunnel produces:
 *
 *   Unauthorized
 *   Unable to reach the origin service
 *   /_next/webpack-hmr ...
 *
 * Which surfaces in the browser as "the page loads but every
 * button mysteriously fails" — the form-action and RSC POSTs
 * are getting 401'd before they reach the route handlers.
 *
 * Allowed hosts:
 *   - localhost:3000 (desktop dev)
 *   - 127.0.0.1 (same as localhost via IP)
 *   - LAN-IP ranges so phones on the same Wi-Fi network can hit
 *     `pnpm dev` directly (NOTE: iOS Safari still won't grant
 *     camera permission over plain HTTP — see docs/MOBILE_TESTING.md)
 *   - *.trycloudflare.com — Cloudflare Quick Tunnel rotates the
 *     subdomain on every restart, so we need the wildcard.
 *     Supported in Next 15.2+. (next.config docs: "Multiple
 *     origins, wildcard subdomains... and IP ranges supported".)
 *   - *.ngrok-free.app and *.ngrok.app — ngrok alternative
 *
 * Production builds don't use allowedDevOrigins; this is dev-only.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'localhost:3000',
    '127.0.0.1',
    // LAN dev — covers the typical 192.168.x.x and 10.x.x.x ranges
    // for phones on the same Wi-Fi as the dev machine.
    '192.168.1.0/24',
    '192.168.0.0/24',
    '10.0.0.0/8',
    // HTTPS tunnel providers — wildcard means we don't have to
    // edit this file every time Cloudflare hands us a new
    // random-words-xyz subdomain.
    '*.trycloudflare.com',
    '*.ngrok-free.app',
    '*.ngrok.app',
  ],
}

export default nextConfig
