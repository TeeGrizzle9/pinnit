# Pinnit

Drop a pin and bring your community together: knitting circles, chess in the park, dance, pickup games and more around Sydney.

Live at https://pinnit.tpotter098.workers.dev

## How it fits together

```
public/            the website (served as static files)
  index.html       the whole app
  cloud-api.js     talks to the server at /api
  spot-rules.js    "is this a public space?" rules, shared by the app and the server
  brand/           logo, favicons, app icons, link preview
worker/            the server (a Cloudflare Worker)
  index.js         every /api route
  setup.js         database tables + the example events, created on first run
wrangler.jsonc     Cloudflare config: site + Worker + D1 database
supabase/          older Supabase version of the backend, kept for reference (not used)
```

- **One shared database** (Cloudflare D1, free tier). Everyone sees the same pins, chats, places and reviews.
- **No passwords.** On first open, people enter their age (under 18s are stopped), a first name and a safety
  promise. The phone gets a random key kept in its browser storage; only a hash of it is stored on the server.
  "Delete my Pinnit" in the profile removes the account and everything it made.
- **Example events** are flagged `is_sample`, labelled "Example" in the app, and repeat weekly so the map is
  never empty. Real events disappear as soon as they finish.
- **Updates arrive by polling**: every 15 seconds for the map, every 4 seconds for an open group chat.

## Deploying

Pushing to `main` on GitHub (TeeGrizzle9/pinnit) redeploys the Worker automatically through Cloudflare
Workers Builds. The first deploy creates the D1 database (`pinnit-db`) by itself, and the Worker creates its
tables and example events on the first request.

The `name` in `wrangler.jsonc` must match the Worker's name in the Cloudflare dashboard (`pinnit`).

## Run it on your computer

```
npx wrangler dev
```

inside this folder, then open http://localhost:8787. It uses a local copy of the database, so nothing touches
the live site.

## Looking at the data

Cloudflare dashboard › Storage & Databases › D1 › `pinnit-db` › Console. Useful queries:

- Reports to review: `SELECT * FROM reports ORDER BY created_at DESC;`
- Verify a venue manager: `UPDATE venues SET manager_verified = 1 WHERE id = '...';`
- Remove an event: `DELETE FROM events WHERE id = '...';` (and its rows in `participants` and `messages`)

## Things to know

- **Public space check:** a pin must be inside a mapped park, sports pitch, school ground, playground, beach or
  plaza, or right next to a named public venue (pool, library, community centre, café). It's refused on
  railway land or within 12 m of tracks, inside buildings in residential areas, and venue points don't count
  in residential areas at all (so backyard pools never pass). The rules read OpenStreetMap data from the same
  OpenFreeMap tiles the map draws, so a check takes a fraction of a second. The app checks as you move the map,
  and the server checks again when an event or place is posted.
- **What it can't catch:** it trusts OpenStreetMap. If a place is mapped wrongly, a pin could go there. Fixing it
  on openstreetmap.org fixes it for everyone (tiles refresh weekly).
- **Moderation is manual for now:** reports are stored in the `reports` table; nobody is notified automatically.
- **The map** uses [OpenFreeMap](https://openfreemap.org) vector tiles: free, no API key, allowed in production.
- **Place prices** are community-edited, like a wiki. Anyone can add or correct a price. Only the person who
  added it, or the venue manager, can remove it.
