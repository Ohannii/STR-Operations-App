# MOBILE_TESTING.md

## TL;DR

**You cannot meaningfully test mobile (iPhone or Android) over `http://192.168.x.x:3000`.**

Browser security gates a bunch of features behind a "secure context"
(HTTPS or `localhost`):

- **In-app camera (`getUserMedia()`)** — flat-out blocked on iOS
  Safari over plain HTTP. "Take photos" will silently do nothing.
- **Form submissions** — iOS Safari pops up a "this information
  is not secure" warning before any POST. Tapping Cancel kills
  the submission silently. The user sees the popup,
  cancels (often without reading), and concludes the button is
  broken.
- **Service workers, clipboard, geolocation** — same gate.

The fix is to point the iPhone at an HTTPS URL that tunnels to
your local dev server. The two practical options:

1. **Cloudflare Quick Tunnel** (recommended — zero account setup, 1 command)
2. **ngrok** (account needed for stable URLs)

Both terminate HTTPS on the tunnel provider and proxy to your
local `pnpm dev` over the LAN.


## Cloudflare Quick Tunnel — 5 minutes

### 1. Install the cloudflared binary

**Windows:**
```
winget install --id Cloudflare.cloudflared
```

(or download the `.exe` from <https://github.com/cloudflare/cloudflared/releases>)

**macOS:**
```
brew install cloudflared
```

### 2. Start your dev server as usual

```
pnpm dev
```

The server listens on `http://localhost:3000`.

### 3. In a SECOND terminal, start the tunnel

```
cloudflared tunnel --url http://localhost:3000
```

You'll see output like:
```
2026-06-02T20:14:35Z INF +--------------------------------------------------------------------------------------------+
2026-06-02T20:14:35Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-06-02T20:14:35Z INF |  https://random-words-xyz.trycloudflare.com                                                |
2026-06-02T20:14:35Z INF +--------------------------------------------------------------------------------------------+
```

That `https://random-words-xyz.trycloudflare.com` URL is the
HTTPS public URL you load on your phone.

### 4. Open the tunnel URL on the iPhone

The first load is slow (cold tunnel). After that you have a
full secure context: camera works, form submissions don't pop
up the security warning, push notifications work, the works.

> **One-time gotcha if you see "Unauthorized" in the cloudflared
> terminal:** Next.js 16's dev server rejects requests whose Host
> header doesn't match a known origin. `*.trycloudflare.com` is
> already in `allowedDevOrigins` in `next.config.ts` — but if you
> see the error anyway, the config was loaded before you added
> the entry. Stop `pnpm dev` (Ctrl+C) and start it again. The
> tunnel URL stays the same; only the dev server restarts.

### 5. When you're done

`Ctrl+C` in the cloudflared terminal — the URL goes away
automatically. Free for as long as you want.

### Caveats

- Quick tunnels are for **dev/test only**. They give you a
  random URL that changes every restart. For staging, use a
  named tunnel + a real domain. Cloudflare's docs are clear
  about this.
- Cookies set on the tunnel URL are scoped to the tunnel
  domain. If you log in on the tunnel URL and then later test
  on `localhost:3000` again, you'll log in fresh (different
  origin = different cookie jar).
- Supabase Storage signed URLs work fine because they point
  at the Supabase HTTPS endpoint, not your dev origin.

### Why we don't ship `next dev --experimental-https`

Next has built-in HTTPS via `next dev --experimental-https`,
but it gives you `https://localhost:3000`. To reach that from
an iPhone on the same Wi-Fi you'd need to:

1. Bind dev to the LAN IP, not localhost
2. Generate a cert for that IP
3. Install + trust the cert on the iPhone (manual profile install)

Compared to one `cloudflared` command, that's a lot of
ceremony for the same outcome. Stick with Cloudflare.


## ngrok alternative

Same shape, requires a free account:

```
npm i -g ngrok
ngrok config add-authtoken <your-token>
ngrok http 3000
```

The output gives you a `https://<random>.ngrok-free.app` URL.
Restrictions: 40 connections/minute on free plan, warning page
on first load.


## What you should see after switching to HTTPS

1. The amber "Testing over an insecure connection" banner on the
   apartment dashboard should disappear.
2. iPhone Safari + Take photos → the camera modal opens, asks
   for camera permission once, then shows the live preview.
3. Discard / Submit / etc. server actions don't pop the
   "not secure" warning.
4. Upload from gallery should attach photos AND the per-file
   status list should show clean "Attached" rows.
5. If any photo still fails, the per-file error row tells you
   exactly why.


## Known not-fixed-yet on mobile

(Tracked for a focused session, not Session 8 evidence camera.)

- "Duplicate test unit 1 after re-login" — likely a signup /
  membership issue. Reproduce by: create new account on phone,
  add a property, log out, log back in. We want to see the
  `companies` and `company_memberships` rows for the affected
  user before patching.
