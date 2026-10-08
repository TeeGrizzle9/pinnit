// Public space rules, shared by the place-pin Edge Function and its tests.
// index.html has a browser copy of the same rules (for demo mode and before the
// function is deployed). If you change one, change the other.

export type Spot = { ok: boolean; kind?: string; name?: string; reason?: 'residential' | 'private' | 'outside'; venue_id?: string };
type Tags = Record<string, string>;
type El = { type: string; tags?: Tags };

export const SYDNEY = { s: -34.20, w: 150.55, n: -33.40, e: 151.40 };
export const inSydney = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= SYDNEY.s && lat <= SYDNEY.n && lng >= SYDNEY.w && lng <= SYDNEY.e;

// OpenStreetMap tags that count as a public space or venue, mapped to a Pinnit venue kind
export const OSM_OK: Record<string, Record<string, string>> = {
  leisure: { park: 'park', pitch: 'court', sports_centre: 'gym', fitness_centre: 'gym', swimming_pool: 'pool', water_park: 'pool', playground: 'park', garden: 'park', recreation_ground: 'field', track: 'field', dog_park: 'park', fitness_station: 'park', common: 'park', nature_reserve: 'park', stadium: 'field', ice_rink: 'gym', sports_hall: 'hall', dance: 'studio', bandstand: 'park', picnic_table: 'park', beach_resort: 'park', golf_course: 'field', bowling_alley: 'other', firepit: 'park', outdoor_seating: 'cafe' },
  amenity: { community_centre: 'hall', social_centre: 'hall', library: 'library', arts_centre: 'studio', townhall: 'hall', school: 'school', college: 'school', university: 'school', cafe: 'cafe', restaurant: 'cafe', pub: 'cafe', bar: 'cafe', biergarten: 'cafe', food_court: 'cafe', ice_cream: 'cafe', place_of_worship: 'hall', theatre: 'hall', cinema: 'other', marketplace: 'other', events_venue: 'hall', bbq: 'park', shelter: 'park', music_venue: 'hall', studio: 'studio', dojo: 'gym', exhibition_centre: 'hall', conference_centre: 'hall', swimming_pool: 'pool' },
  tourism: { museum: 'other', gallery: 'studio', picnic_site: 'park', attraction: 'other', viewpoint: 'park', zoo: 'park' },
  natural: { beach: 'park' },
  landuse: { recreation_ground: 'field', village_green: 'park' },
  place: { square: 'park' },
  highway: { pedestrian: 'park' }
};
export const RES_BUILDINGS = ['house', 'residential', 'apartments', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'dormitory', 'houseboat', 'static_caravan'];
const KIND_RANK = ['pool', 'court', 'gym', 'studio', 'hall', 'library', 'cafe', 'park', 'field', 'school', 'other'];
const KIND_LABEL: Record<string, string> = { pool: 'Pool', court: 'Court', field: 'Field or oval', park: 'Park', hall: 'Community hall', school: 'School', gym: 'Gym', studio: 'Studio', library: 'Library', cafe: 'Café', other: 'Venue' };

export function classifyTags(t: Tags): string | null {
  for (const k of Object.keys(OSM_OK)) {
    const kind = t[k] && OSM_OK[k][t[k]];
    if (kind) return /swimming/.test(t.sport || '') && ['gym', 'court'].includes(kind) ? 'pool' : kind;
  }
  return null;
}
function featureName(t: Tags, kind: string) {
  if (t.name) return t.name;
  if (t.leisure === 'pitch' && t.sport) {
    const sp = t.sport.split(';')[0].replace(/_/g, ' ');
    return sp.charAt(0).toUpperCase() + sp.slice(1) + (/basketball|tennis|netball|volleyball|badminton|pickleball|squash|handball/.test(sp) ? ' court' : ' field');
  }
  return KIND_LABEL[kind] || 'Venue';
}

// Areas the point is inside (parks, courts, pools, schools, plazas, buildings, land use),
// plus small venue points (cafés, libraries, BBQs) right next to it.
// Being near a park is not enough: a house across the road from a park must not pass.
export function spotQuery(lat: number, lng: number) {
  const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  return `[out:json][timeout:10];is_in(${ll})->.a;area.a->.enc;.enc out tags;` +
    `(node(around:15,${ll})[~"^(leisure|amenity|tourism|natural|place)$"~"."];way(around:8,${ll})[highway=pedestrian];)->.near;.near out tags 40;`;
}

export function decideSpot(elements: El[]): Spot {
  const hits: { kind: string; tags: Tags; inside: boolean }[] = [];
  let inHome = false, inResidentialArea = false;
  for (const el of elements) {
    const t = el.tags || {}, inside = el.type === 'area', kind = classifyTags(t);
    if (inside && RES_BUILDINGS.includes(t.building)) inHome = true;
    if (inside && t.landuse === 'residential') inResidentialArea = true;
    if (kind) hits.push({ kind, tags: t, inside });
  }
  // standing inside a house or apartment block: never allowed, even inside a park or next to a café
  if (inHome) return { ok: false, reason: 'residential' };
  if (!hits.length) return { ok: false, reason: inHome || inResidentialArea ? 'residential' : 'private' };
  // name it after the most specific place: a pool or court (inside or right here) beats the park around it
  const broad = (k: string) => ['park', 'field', 'school', 'other'].includes(k);
  hits.sort((a, b) => (Number(broad(a.kind)) - Number(broad(b.kind))) || (Number(b.inside) - Number(a.inside)) || (KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind)));
  const best = hits[0], around = best.tags.name ? null : hits.find(h => h.tags.name);
  // an unnamed pool inside "Victoria Park Pool" is just Victoria Park Pool
  if (around && around.kind === best.kind) return { ok: true, kind: best.kind, name: around.tags.name };
  // an unnamed court in a named park reads "Basketball court at Prince Alfred Park"
  return { ok: true, kind: best.kind, name: featureName(best.tags, best.kind) + (around ? ' at ' + around.tags.name : '') };
}

export async function checkSpotOverpass(lat: number, lng: number, timeoutMs = 9000): Promise<Spot> {
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(spotQuery(lat, lng)),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'Pinnit/1.0 (community events app)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error('Overpass ' + r.status);
  return decideSpot((await r.json()).elements || []);
}
