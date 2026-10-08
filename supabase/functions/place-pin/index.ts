// place-pin: the only way to put an event or venue on the map once public-spaces.sql
// has locked direct inserts. It checks the spot is a public space on the server, so the
// rule holds even for someone calling the database directly.
//
//   { type: 'check', lat, lng }   -> { ok, kind, name, reason }
//   { type: 'event', row }        -> { id }   (row is the events insert the app builds)
//   { type: 'venue', row }        -> { id }
//
// Deploy: Supabase dashboard > Edge Functions > Deploy a new function > name it "place-pin",
// paste this file and spot.ts. Or with the CLI: supabase functions deploy place-pin
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkSpotOverpass, inSydney, type Spot } from './spot.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const CACHE_DAYS = 30;
const MESSAGES = {
  residential: "Pins can't go in residential areas. Move it to a park, court or public venue.",
  private: 'Pins need to be in a park, court, plaza or public venue.',
  outside: 'Pinnit is Sydney only for now.',
  unavailable: "We couldn't check this spot right now. Try again in a minute."
};

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function verifySpot(lat: number, lng: number, type: string): Promise<Spot> {
  if (!inSydney(lat, lng)) return { ok: false, reason: 'outside' };
  // a venue already on Pinnit was checked when it was added
  if (type !== 'venue') {
    const { data } = await admin.from('venues').select('id,name,kind,lat,lng')
      .gte('lat', lat - 0.0005).lte('lat', lat + 0.0005).gte('lng', lng - 0.0006).lte('lng', lng + 0.0006);
    const v = (data || []).find(v => Math.hypot((v.lat - lat) * 111000, (v.lng - lng) * 92000) <= 50);
    if (v) return { ok: true, kind: v.kind, name: v.name, venue_id: v.id };
  }
  // about 1 m grid, so a cached answer never leaks across a park boundary
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const { data: cached } = await admin.from('spot_checks').select('result,checked_at').eq('key', key).maybeSingle();
  if (cached && Date.now() - +new Date(cached.checked_at) < CACHE_DAYS * 864e5) return cached.result as Spot;
  const result = await checkSpotOverpass(lat, lng); // throws if the map data service is down: we never guess
  await admin.from('spot_checks').upsert({ key, result, checked_at: new Date().toISOString() });
  return result;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(jwt);
  if (!auth?.user) return json({ error: 'Log in first' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const type = body?.type;
  if (!['check', 'event', 'venue'].includes(type)) return json({ error: 'Bad request' }, 400);
  const lat = Number(type === 'check' ? body.lat : body.row?.lat), lng = Number(type === 'check' ? body.lng : body.row?.lng);

  let spot: Spot;
  try { spot = await verifySpot(lat, lng, type); }
  catch (e) { console.error('spot check failed', e); return json({ error: MESSAGES.unavailable, reason: 'unavailable' }, 503); }

  if (type === 'check') return json(spot);
  if (!spot.ok) return json({ error: MESSAGES[spot.reason || 'private'], reason: spot.reason }, 422);

  const row = { ...body.row };
  if (type === 'event' && spot.venue_id && !row.venue_id) row.venue_id = spot.venue_id;
  const { data, error } = await admin.rpc(type === 'event' ? 'place_event' : 'place_venue', { p_user: auth.user.id, p_row: row });
  if (error) return json({ error: error.message }, 400);
  return json({ id: data });
});
