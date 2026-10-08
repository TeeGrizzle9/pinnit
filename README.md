# Pinnit

Drop a pin and bring your community together: knitting circles, chess in the park, dance, pickup games and more around Sydney.

## Files

- `index.html`: the whole app.
- `local-api.js`: the built-in backend the app runs on right now (see below).
- `site.webmanifest` and `brand/`: logo, favicons and "Add to Home Screen" icons from the Pinnit logo kit.
- `supabase/`: database scripts and the `place-pin` function, for when we move to a shared backend.

## How it works right now (no server)

Pinnit currently runs entirely in the browser, so anyone can scan the QR code and use it with no
sign-up. On first open it asks for their age (under 18s are stopped and the phone remembers that),
a first name and a safety promise. Everything they do (pins, joins, chat, reviews, badges) is saved
on **that phone only** via localStorage, alongside a small sample Sydney community. Nothing is
shared between phones. "Start over on this phone" in the profile wipes it, which is handy for
handing a demo phone to the next person.

Things that only make sense with a shared backend and are local-only for now: reports and blocks
(saved on the phone, nobody reviews them), friend requests (the sample locals accept automatically),
and the "did you feel safe?" answers.

## Run it on your computer

```
node .claude/serve.js
```

(from the folder above this one), then open http://localhost:5173. Or `python -m http.server 5173` inside this folder.

## Deploying (Cloudflare Pages)

The site is plain static files, so there is no build step. In Cloudflare Pages, connect the GitHub
repo, leave the build command empty and set the build output directory to `/` (or to `pinnit-app`
if the repo also contains the logo kit). Every push redeploys automatically.

After the first deploy, change the `og:image` meta tag in `index.html` to the full address
(e.g. `https://pinnit.pages.dev/brand/pinnit-link-preview-1200x630.png`) so link previews show the logo.

## Switching to the real backend (later)

1. In `index.html`, replace `<script src="local-api.js"></script>` with `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`.
2. Supabase › SQL Editor: paste in `supabase/community-update.sql` and run it.
3. In Supabase › Authentication › URL Configuration, add the Cloudflare Pages address.
4. Reviews, reports, blocks, safety check-ins and badges still need tables and `makeApi()` methods; they're local-only today.

## Making "public spaces only" impossible to get around

Without these steps, the check runs only in the browser. Do both, one straight after the other:

3. Supabase › SQL Editor: run `supabase/public-spaces.sql`. From then on, nobody can add events or venues straight into the database.
4. Supabase › Edge Functions › Deploy a new function › name it `place-pin`. Add the two files from `supabase/functions/place-pin/`, `index.ts` and `spot.ts`, then deploy. With the CLI instead: `supabase functions deploy place-pin`.

Between steps 3 and 4 nobody can post. Once both are done, every new pin is checked against OpenStreetMap on the server before it's saved. If OpenStreetMap's map data can't be reached, the pin is refused with "try again" rather than let through. Checked spots are cached for 30 days in `spot_checks`. Pins can't be moved after they're placed.

To undo the lock, run `grant insert on public.events, public.venues to authenticated;`

## Verifying venue managers

Anyone can tap "I manage this" on a venue that has no manager. They're shown as **Not yet verified** until you confirm who they are. Then open Supabase › Table Editor › `venues` and set `manager_verified` to `true`.

## Things to know

- **Public space check:** a pin must be *inside* a park, court, pool, school, beach or plaza, or within 15 m of a venue point such as a café or library. Being near a park isn't enough, so a house across the road won't pass. Anything inside a house or apartment block is always refused. The rules live in `supabase/functions/place-pin/spot.ts`, with a browser copy in `index.html` used by the local backend. Keep the two in step.
- **What it can't catch:** it trusts OpenStreetMap. If a place is mapped wrongly (say a private garden tagged as a park), a pin could go there. Fix that on openstreetmap.org and everyone benefits.
- **The map** uses [OpenFreeMap](https://openfreemap.org) vector tiles: free, no API key, no account, no request limits, and allowed in production. It's drawn by MapLibre GL inside Leaflet using the "Positron" style, with parks and sports grounds tinted green so public spaces stand out. If WebGL isn't available or OpenFreeMap can't be reached, the app falls back to OpenStreetMap's own tiles, which suit light use only. OpenFreeMap is run by one person on donations with no uptime guarantee. If you ever need one, its tiles can be self-hosted, or you can move to a paid provider by changing `BASEMAP.style`.
- **Venue prices** are community-edited, like a wiki. Anyone signed in can add or correct a price. Only the person who added it, or the venue manager, can remove it.
