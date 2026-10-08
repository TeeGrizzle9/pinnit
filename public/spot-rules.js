// Pinnit public-space rules, shared by the app (browser) and the Worker (server).
//
// Pins may only go inside a mapped public space (park, sports pitch, school grounds, playground,
// beach, plaza) or right next to a public venue (pool, library, community centre, café). They're
// refused on railway land or near tracks, and inside buildings in residential areas, so homes stay
// private. The map data is OpenStreetMap, read from the same OpenFreeMap vector tiles the map
// already draws, so a check takes milliseconds instead of waiting on a public Overpass server.

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;                                   // OpenMapTiles has full detail at zoom 14
export const SYDNEY = { s: -34.20, w: 150.55, n: -33.40, e: 151.40 };
export const inSydney = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= SYDNEY.s && lat <= SYDNEY.n && lng >= SYDNEY.w && lng <= SYDNEY.e;

/* ---------- what counts ---------- */
const LANDUSE_KIND = { school: 'school', university: 'school', college: 'school', kindergarten: 'school', library: 'library', stadium: 'field', pitch: 'court', playground: 'park', track: 'field', zoo: 'park', theme_park: 'park' };
const GRASS_OK = ['park', 'recreation_ground', 'village_green', 'garden', 'golf_course', 'common'];
// venue points (OpenStreetMap tag values) and how close a pin must be
const POI_KIND = {
  swimming_pool: 'pool', water_park: 'pool', sports_centre: 'gym', fitness_centre: 'gym', sports_hall: 'hall', ice_rink: 'gym', dojo: 'gym',
  stadium: 'field', pitch: 'court', track: 'field', playground: 'park', park: 'park', garden: 'park', dog_park: 'park', picnic_site: 'park', bbq: 'park', shelter: 'park', viewpoint: 'park', beach: 'park',
  community_centre: 'hall', social_centre: 'hall', townhall: 'hall', events_venue: 'hall', place_of_worship: 'hall', theatre: 'hall', music_venue: 'hall', exhibition_centre: 'hall', conference_centre: 'hall',
  library: 'library', arts_centre: 'studio', gallery: 'studio', dance: 'studio', studio: 'studio', museum: 'other', cinema: 'other', marketplace: 'other', attraction: 'other',
  school: 'school', college: 'school', university: 'school',
  cafe: 'cafe', restaurant: 'cafe', pub: 'cafe', bar: 'cafe', biergarten: 'cafe', food_court: 'cafe', ice_cream: 'cafe'
};
const BIG_POI = ['swimming_pool', 'water_park', 'sports_centre', 'stadium', 'school', 'college', 'university', 'community_centre', 'townhall', 'library', 'place_of_worship', 'theatre', 'arts_centre', 'museum'];
const NEAR_SMALL = 15, NEAR_BIG = 45, RAIL_GAP = 12;  // metres
const KIND_RANK = ['pool', 'court', 'gym', 'studio', 'hall', 'library', 'cafe', 'park', 'field', 'school', 'other'];
const KIND_LABEL = { pool: 'Pool', court: 'Court', field: 'Field or oval', park: 'Park', hall: 'Community hall', school: 'School', gym: 'Gym', studio: 'Studio', library: 'Library', cafe: 'Café', other: 'Venue' };
export const SPOT_MESSAGES = {
  residential: "Pins can't go on homes. Move it to a park, court or public venue.",
  rail: "That's on or right next to a railway. Move it somewhere safe to meet.",
  private: 'Pins need to be in a park, court, plaza or public venue.',
  outside: 'Pinnit is Sydney only for now.',
  unavailable: "We couldn't check this spot right now. Try again in a minute."
};

/* ---------- tiny Mapbox Vector Tile (protobuf) reader ---------- */
const WANT = new Set(['park', 'landuse', 'landcover', 'poi', 'transportation', 'building']);
function readTile(buf) {
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const skip = w => { if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 2) p += varint(); else if (w === 5) p += 4; };
  const str = (a, b) => new TextDecoder().decode(buf.subarray(a, b));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const layers = {};
  while (p < buf.length) {
    const t = varint(), f = t >> 3, w = t & 7;
    if (f !== 3 || w !== 2) { skip(w); continue; }
    const len = varint(), end = p + len;
    const L = { name: '', extent: 4096, keys: [], values: [], raw: [] };
    while (p < end) {
      const t2 = varint(), f2 = t2 >> 3, w2 = t2 & 7;
      if (f2 === 1) { const l = varint(); L.name = str(p, p + l); p += l; }
      else if (f2 === 2) { const l = varint(); L.raw.push([p, p + l]); p += l; }
      else if (f2 === 3) { const l = varint(); L.keys.push(str(p, p + l)); p += l; }
      else if (f2 === 4) {
        const l = varint(), ve = p + l; let v = null;
        while (p < ve) {
          const t3 = varint(), f3 = t3 >> 3;
          if (f3 === 1) { const l3 = varint(); v = str(p, p + l3); p += l3; }
          else if (f3 === 2) { v = dv.getFloat32(p, true); p += 4; }
          else if (f3 === 3) { v = dv.getFloat64(p, true); p += 8; }
          else if (f3 === 4 || f3 === 5) v = varint();
          else if (f3 === 6) { const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
          else if (f3 === 7) v = !!varint();
          else skip(t3 & 7);
        }
        L.values.push(v);
      }
      else if (f2 === 5) L.extent = varint();
      else skip(w2);
    }
    if (WANT.has(L.name)) layers[L.name] = L;
    p = end;
  }
  // decode features lazily per layer
  for (const L of Object.values(layers)) {
    L.features = L.raw.map(([a, b]) => {
      p = a; const F = { tags: {}, type: 0, rings: [] }; let geom = [];
      while (p < b) {
        const t = varint(), f = t >> 3, w = t & 7;
        if (f === 3) F.type = varint();
        else if ((f === 2 || f === 4) && w === 2) { const len = varint(), e = p + len, out = []; while (p < e) out.push(varint()); if (f === 2) { for (let i = 0; i < out.length; i += 2) F.tags[L.keys[out[i]]] = L.values[out[i + 1]]; } else geom = out; }
        else skip(w);
      }
      let x = 0, y = 0, ring = null;
      for (let i = 0; i < geom.length;) {
        const c = geom[i++], id = c & 7, n = c >> 3;
        if (id === 7) { if (ring && ring.length) ring.push(ring[0]); continue; }
        for (let k = 0; k < n; k++) {
          const dx = geom[i++], dy = geom[i++];
          x += dx % 2 ? -(dx + 1) / 2 : dx / 2; y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
          if (id === 1) { ring = [[x, y]]; F.rings.push(ring); } else ring.push([x, y]);
        }
      }
      return F;
    });
    delete L.raw;
  }
  return layers;
}

/* ---------- geometry in tile units ---------- */
function inside(pt, rings) {
  let c = false;
  for (const r of rings) for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function distToLines(pt, rings) {
  let d = Infinity;
  for (const r of rings) for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i], dx = b[0] - a[0], dy = b[1] - a[1];
    let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy || 1); t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(pt[0] - a[0] - t * dx, pt[1] - a[1] - t * dy));
  }
  return d;
}
export function tileFor(lat, lng, z = Z) {
  const n = 2 ** z, x = (lng + 180) / 360 * n, r = lat * Math.PI / 180, y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return { z, x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}

/* ---------- the decision ---------- */
export function decideFromTile(layers, t, lat) {
  const ext = (layers.landuse || layers.park || layers.poi || { extent: 4096 }).extent;
  const pt = [t.fx * ext, t.fy * ext];
  const mPerUnit = 40075016.7 * Math.cos(lat * Math.PI / 180) / 2 ** t.z / ext;
  const feats = name => (layers[name] && layers[name].features) || [];
  const polysAt = name => feats(name).filter(f => f.type === 3 && inside(pt, f.rings));

  // 1. railways: never
  if (polysAt('landuse').some(f => f.tags.class === 'railway')) return { ok: false, reason: 'rail' };
  if (feats('transportation').some(f => f.type === 2 && ['rail', 'transit'].includes(f.tags.class) && !f.tags.brunnel && distToLines(pt, f.rings) * mPerUnit < RAIL_GAP)) return { ok: false, reason: 'rail' };

  const landuse = polysAt('landuse'), parks = polysAt('park'), cover = polysAt('landcover');
  const residential = landuse.some(f => f.tags.class === 'residential');
  // 2. inside a building in a residential area: that's someone's home
  if (residential && polysAt('building').length) return { ok: false, reason: 'residential' };

  const hits = [];
  parks.forEach(f => hits.push({ kind: 'park', name: f.tags.name || f.tags['name:en'] || null, inside: true, area: true }));
  landuse.forEach(f => { const k = LANDUSE_KIND[f.tags.class]; if (k) hits.push({ kind: k, name: null, inside: true, area: true }); });
  cover.forEach(f => {
    if (f.tags.class === 'sand' && f.tags.subclass === 'beach') hits.push({ kind: 'park', name: 'Beach', inside: true, area: true, beach: true });
    if (f.tags.class === 'grass' && GRASS_OK.includes(f.tags.subclass)) hits.push({ kind: 'park', name: null, inside: true, area: true });
  });
  // venue points only count when they're named and the spot isn't in a residential area:
  // OpenStreetMap maps plenty of backyard and apartment-block pools, and those must never pass
  const poiDist = f => Math.min(...f.rings.map(r => Math.hypot(r[0][0] - pt[0], r[0][1] - pt[1]))) * mPerUnit;
  const poiKind = f => { const k = POI_KIND[f.tags.subclass] || POI_KIND[f.tags.class]; return k === 'gym' && /pool|aquatic|swim/i.test(f.tags.name || '') ? 'pool' : k; };
  const pois = feats('poi').filter(f => f.type === 1 && f.tags.name && poiKind(f));
  if (!residential) pois.forEach(f => {
    const d = poiDist(f), lim = BIG_POI.includes(f.tags.subclass) ? NEAR_BIG : NEAR_SMALL;
    if (d <= lim) hits.push({ kind: poiKind(f), name: f.tags.name, inside: false, d });
  });
  if (!hits.length) return { ok: false, reason: residential ? 'residential' : 'private' };

  // name it after the most specific place: a pool or court beats the park around it
  const broad = k => ['park', 'field', 'school', 'other'].includes(k);
  hits.sort((a, b) => (broad(a.kind) - broad(b.kind)) || (KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind)) || ((a.d || 0) - (b.d || 0)));
  const best = hits[0];
  // park names live on label points, not the park shapes: use the closest named park or garden
  const parkName = (pois.filter(f => ['park', 'garden', 'nature_reserve', 'recreation_ground', 'common'].includes(f.tags.subclass) || f.tags.class === 'park')
    .map(f => ({ name: f.tags.name, d: poiDist(f) })).filter(x => x.d < 350).sort((a, b) => a.d - b.d)[0] || {}).name
    || (hits.find(h => h.area && h.name && !h.beach) || {}).name;
  let name = best.name;
  if (!name || name === 'Beach') name = best.kind === 'park' && parkName ? parkName : (best.beach ? 'Beach' : KIND_LABEL[best.kind] + (parkName ? ' at ' + parkName : ''));
  return { ok: true, kind: best.kind, name };
}

/* ---------- fetching tiles (browser and Worker both have fetch) ---------- */
let tileUrl = null, tileUrlAt = 0;
const cache = new Map();
async function bytes(r) {
  let b = new Uint8Array(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return b;
}
export async function loadTile(t, fetchFn = fetch) {
  const key = `${t.z}/${t.x}/${t.y}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (!tileUrl || Date.now() - tileUrlAt > 6 * 3600e3) {
      const j = await (await fetchFn(TILEJSON)).json();
      tileUrl = j.tiles[0]; tileUrlAt = Date.now();
    }
    const r = await fetchFn(tileUrl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
    if (!r.ok) throw new Error('Map tile ' + r.status);
    return readTile(await bytes(r));
  })();
  cache.set(key, p);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  p.catch(() => cache.delete(key));
  return p;
}
// the whole check: throws if map data can't be loaded (callers must not guess)
export async function checkSpot(lat, lng, fetchFn) {
  if (!inSydney(lat, lng)) return { ok: false, reason: 'outside' };
  const t = tileFor(lat, lng);
  return decideFromTile(await loadTile(t, fetchFn), t, lat);
}
// named public places near a refused spot, to suggest instead
export async function nearbySpaces(lat, lng, fetchFn) {
  const t = tileFor(lat, lng), layers = await loadTile(t, fetchFn), ext = (layers.park || layers.poi || { extent: 4096 }).extent, n = 2 ** t.z;
  const toLL = (px, py) => { const x = (t.x + px / ext) / n, y = (t.y + py / ext) / n; return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180]; };
  const out = [];
  (layers.park ? layers.park.features : []).forEach(f => {
    if (!f.tags.name || f.type !== 3) return;
    // a point well inside the park: the vertex-average, nudged to the nearest vertex if it falls outside
    const pts = f.rings.flat(); let cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    if (!inside([cx, cy], f.rings)) [cx, cy] = pts[0];
    const [la, ln] = toLL(cx, cy);
    out.push({ name: f.tags.name, kind: 'park', lat: la, lng: ln });
  });
  (layers.poi ? layers.poi.features : []).forEach(f => {
    const k = POI_KIND[f.tags.subclass]; if (!k || !f.tags.name || k === 'cafe') return;
    const [la, ln] = toLL(f.rings[0][0][0], f.rings[0][0][1]); out.push({ name: f.tags.name, kind: k, lat: la, lng: ln });
  });
  const km = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 92);
  const seen = new Set();
  return out.map(x => ({ ...x, d: km([lat, lng], [x.lat, x.lng]) })).sort((a, b) => a.d - b.d).filter(x => !seen.has(x.name) && seen.add(x.name)).slice(0, 3);
}
