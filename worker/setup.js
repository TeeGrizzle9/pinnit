import { REGION_PEOPLE, REGION_PLACES, REGION_EVENTS } from './seed-region.js';

// Database tables, created on first use, plus a small set of example events so the map isn't
// empty on day one. Example events and people are flagged is_sample and labelled in the app.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, display_name TEXT NOT NULL, bio TEXT, age_bracket TEXT, gender TEXT,
  avatar_url TEXT, referral_code TEXT UNIQUE, is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, host_id TEXT NOT NULL, activity TEXT NOT NULL, category TEXT, title TEXT, notes TEXT, meeting_point TEXT,
  skill TEXT, cost REAL, max_people INTEGER NOT NULL, starts_at TEXT NOT NULL, duration_mins INTEGER NOT NULL,
  gender_rule TEXT NOT NULL DEFAULT 'everyone', age_brackets TEXT, noise_level TEXT, access TEXT, venue_id TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL, place TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_start_idx ON events(starts_at);
CREATE TABLE IF NOT EXISTS participants (event_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at TEXT NOT NULL, arrived_at TEXT, PRIMARY KEY (event_id, user_id));
CREATE INDEX IF NOT EXISTS participants_user_idx ON participants(user_id);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_event_idx ON messages(event_id, created_at);
CREATE TABLE IF NOT EXISTS checkins (event_id TEXT NOT NULL, user_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (event_id, user_id));
CREATE TABLE IF NOT EXISTS friendships (user_a TEXT NOT NULL, user_b TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_a, user_b));
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, address TEXT, description TEXT, website TEXT,
  access TEXT, created_by TEXT, manager_id TEXT, manager_verified INTEGER NOT NULL DEFAULT 0, prices_checked_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_prices (id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, label TEXT NOT NULL, price REAL NOT NULL, unit TEXT NOT NULL, note TEXT, created_by TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS venue_slots (id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, days TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, note TEXT, posted_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, user_id TEXT NOT NULL, rating INTEGER NOT NULL, body TEXT, photo TEXT, created_at TEXT NOT NULL, UNIQUE (venue_id, user_id));
CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT, kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (user_id TEXT NOT NULL, blocked_id TEXT NOT NULL, PRIMARY KEY (user_id, blocked_id));
CREATE TABLE IF NOT EXISTS safety (user_id TEXT NOT NULL, event_id TEXT NOT NULL, feel TEXT, note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, event_id));
CREATE TABLE IF NOT EXISTS badges (user_id TEXT NOT NULL, badge_id TEXT NOT NULL, PRIMARY KEY (user_id, badge_id));
CREATE TABLE IF NOT EXISTS spot_checks (key TEXT PRIMARY KEY, result TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS restore_attempts (ip TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (invitee_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, event_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS invites_inviter_idx ON invites(inviter_id);
CREATE TABLE IF NOT EXISTS cancellations (user_id TEXT NOT NULL, event_id TEXT NOT NULL, hours_ahead REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (user_id, event_id));
CREATE TABLE IF NOT EXISTS moderation_log (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, reason TEXT NOT NULL, excerpt TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS restore_attempts_idx ON restore_attempts(ip, at);
`;

// Columns added after launch. CREATE TABLE IF NOT EXISTS won't add them to an existing table,
// so add any that are missing (existing data is kept).
const ADDED_COLUMNS = [['profiles', 'recovery_hash', 'TEXT'], ['profiles', 'points', 'INTEGER NOT NULL DEFAULT 0'], ['events', 'filled_at', 'TEXT']];
async function migrate(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!results.some(c => c.name === col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS profiles_recovery_idx ON profiles(recovery_hash)').run();
}

// Each request runs setup itself until one finishes. A Worker must never await a promise started by
// another request: if that request is cancelled, its database calls die and everyone waiting hangs.
// Setup is safe to run twice at once (CREATE IF NOT EXISTS, INSERT OR IGNORE with fixed ids).
let ready = false;
export async function ensureReady(db) {
  if (ready) return;
  await setup(db);
  ready = true;
}
async function setup(db) {
  await db.batch(SCHEMA.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await migrate(db);
  const seeded = await db.prepare("SELECT value FROM meta WHERE key = 'seeded'").first();
  if (!seeded) await seed(db);
  const greater = await db.prepare("SELECT value FROM meta WHERE key = 'seeded_greater'").first();
  if (!greater) await seedGreaterSydney(db);
  const places = await db.prepare("SELECT value FROM meta WHERE key = 'seeded_places'").first();
  if (!places) await seedNotablePlaces(db);
  const region = await db.prepare("SELECT value FROM meta WHERE key = 'seeded_region'").first();
  if (!region) await seedRegion(db);
}

// Run statements in batches small enough for D1.
async function batched(db, S) {
  for (let i = 0; i < S.length; i += 40) await db.batch(S.slice(i, i + 40));
}

// Example times are set in Sydney local time on a given weekday, so a "dawn" walk really is at dawn.
// The weekly roll-forward then moves them by whole weeks and they keep their hour.
function sydneyClock(NOW) {
  const H = 3600e3, D = 864e5;
  const parts = (ms, o) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', ...o }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const offset = ms => { const p = parts(ms, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60e3) * 60e3; };
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const sydneyAt = (days, hh, mm) => {
    const p = parts(NOW + days * D, { year: 'numeric', month: 'numeric', day: 'numeric' });
    const wall = Date.UTC(+p.year, p.month - 1, +p.day, hh, mm);
    return wall - offset(wall - 10 * H);
  };
  // the next time it is weekday `dow` at hh:mm in Sydney, skipping one that has already finished
  return (dow, hh, mm, mins) => {
    const days = (dow - DOW[parts(NOW, { weekday: 'short' }).weekday] + 7) % 7;
    let t = sydneyAt(days, hh, mm);
    if (t + mins * 60e3 <= NOW) t = sydneyAt(days + 7, hh, mm);
    return new Date(t).toISOString();
  };
}

// Official websites, each checked to load and name the place (2026-10). Example local places across
// Greater Sydney, generated from OpenStreetMap data and passed through the public-space check, with
// a couple of example events in each area. Example events and the original ones get local times.
async function seedRegion(db) {
  const NOW = Date.now(), D = 864e5, H = 3600e3, iso = ms => new Date(ms).toISOString(), when = sydneyClock(NOW);
  const S = [], add = (sql, ...args) => S.push(db.prepare(sql).bind(...args));
  Object.entries({
    np0: 'https://www.cityofsydney.nsw.gov.au/parks/sydney-park', np1: 'https://www.centennialparklands.com.au/',
    np2: 'https://www.botanicgardens.org.au/royal-botanic-garden-sydney', np3: 'https://www.barangaroo.com/',
    np4: 'https://www.cityofsydney.nsw.gov.au/parks/rushcutters-bay-park', np5: 'https://www.sydneyolympicpark.com.au/parks-and-playgrounds/bicentennial-park',
    np6: 'https://www.cityofparramatta.nsw.gov.au/community/parks-and-public-spaces/find-a-park-or-reseve/lake-parramatta-reserve',
    np7: 'https://www.greatersydneyparklands.nsw.gov.au/bungarribee-park', np8: 'https://www.greatersydneyparklands.nsw.gov.au/explore/nurragingy-reserve',
    np11: 'https://sutherlandshire.nsw.gov.au/play-and-explore/the-outdoors/parks-and-reserves/all-parks-reserves/gunnamatta-park-cronulla',
    np12: 'https://cityofsydneyleisure.com.au/visit/cook-phillip-park-pool', np13: 'https://wylies.com.au/',
    np14: 'https://www.sydneyolympicpark.nsw.gov.au/aquatic-centre', np15: 'https://www.ryde.nsw.gov.au/RALC',
    np16: 'https://www.cityofparramatta.nsw.gov.au/the-pac/home', np17: 'https://www.whitlamleisurecentre.com.au/',
    np18: 'https://leisure.sutherlandshire.nsw.gov.au/locations/sutherland-leisure-centre', np19: 'https://www.blacktownaquaticandsports.com.au/Home',
    np20: 'https://www.sl.nsw.gov.au/', np21: 'https://www.cityofsydney.nsw.gov.au/libraries/customs-house-library',
    np22: 'https://cityofparramatta.nsw.gov.au/phive/library', np23: 'https://penrithcity.nsw.gov.au/community-library/library',
    np24: 'https://www.casulapowerhouse.com/', np25: 'https://www.bankstownartscentre.com.au/',
    v1: 'https://cityofsydneyleisure.com.au/visit/victoria-park-pool', v2: 'https://cityofsydneyleisure.com.au/visit/ian-thorpe-aquatic-centre',
    v4: 'https://www.cityofsydney.nsw.gov.au/landmarks/glebe-town-hall', v6: 'https://www.cityofsydney.nsw.gov.au/parks/victoria-park',
    v8: 'https://www.hornsby.nsw.gov.au/halc', v10: 'https://www.greatersydneyparklands.nsw.gov.au/parramatta-park'
  }).forEach(([id, url]) => add('UPDATE venues SET website = ? WHERE id = ? AND website IS NULL', url, id));

  REGION_PEOPLE.forEach(([id, name, age, gender, bio]) => add('INSERT OR IGNORE INTO profiles (id, display_name, age_bracket, gender, bio, is_sample, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, name, age, gender, bio, iso(NOW - 40 * D)));
  const ocean = /rock ?pool|beach pool|memorial pool/i;
  const about = (kind, name) => kind === 'park' ? 'Local park. Free to use.'
    : kind === 'pool' ? (ocean.test(name) ? 'Ocean pool. Free to use. Check the surf conditions before you swim.' : 'Public pool. Check hours and entry prices with the centre.')
    : kind === 'library' ? 'Public library. Free entry.' : 'Community venue. Check hours and hire with the venue.';
  REGION_PLACES.forEach(([id, name, kind, lat, lng, area, free], i) => {
    const by = REGION_PEOPLE[i % REGION_PEOPLE.length][0];
    add('INSERT OR IGNORE INTO venues (id, name, kind, lat, lng, address, description, website, access, created_by, manager_id, manager_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?)',
      id, name, kind, lat, lng, 'Near ' + area, about(kind, name), '[]', by, iso(NOW - (8 + i % 20) * D));
    if (free) add("INSERT OR IGNORE INTO venue_prices (id, venue_id, label, price, unit, note, created_by, updated_by, updated_at) VALUES (?, ?, 'Entry', 0, 'entry', 'Free to use', ?, ?, ?)", 'pr-' + id, id, by, by, iso(NOW - 3 * D));
  });
  REGION_EVENTS.forEach(e => {
    add(`INSERT OR IGNORE INTO events (id, host_id, activity, category, title, notes, meeting_point, skill, cost, max_people, starts_at, duration_mins, gender_rule, age_brackets, noise_level, access, venue_id, lat, lng, place, is_sample, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'All levels', NULL, ?, ?, ?, 'everyone', NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
      e.id, e.host, e.activity, e.category, e.title, e.notes, e.max, when(e.day, e.hh, e.mm, e.dur), e.dur, e.noise, JSON.stringify(e.access), e.venue, e.lat, e.lng, e.place, iso(NOW));
    [e.host, ...e.people].forEach(u => add('INSERT OR IGNORE INTO participants (event_id, user_id, joined_at) VALUES (?, ?, ?)', e.id, u, iso(NOW - H)));
  });

  // the first examples were set a number of hours from launch; give them sensible local days and times
  [['ex0', 0, 10, 0], ['ex1', 3, 14, 0], ['ex2', 6, 9, 0], ['ex3', 4, 17, 30], ['ex4', 2, 7, 30], ['ex5', 6, 8, 0], ['ex6', 5, 16, 0],
   ['ex7', 2, 11, 0], ['ex8', 3, 6, 30], ['ex9', 0, 6, 30], ['gs0', 1, 9, 30], ['gs1', 4, 18, 0], ['gs2', 6, 10, 0], ['gs3', 2, 18, 0],
   ['gs4', 0, 10, 30], ['gs5', 5, 6, 30], ['gs6', 3, 18, 0], ['gs7', 0, 7, 0]]
    .forEach(([id, dow, hh, mm]) => S.push(db.prepare('UPDATE events SET starts_at = ? WHERE id = ? AND is_sample = 1')
      .bind(when(dow, hh, mm, 180), id)));
  add("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_region', ?)", iso(NOW));
  add("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
  await batched(db, S);
}

// Notable public places across Greater Sydney (added 2026-10). Coordinates come from OpenStreetMap
// via the map tiles and each passed the public-space check. No prices are invented: parks and
// libraries are marked free; pools and arts centres are left for locals to add prices.
async function seedNotablePlaces(db) {
  const NOW = Date.now(), D = 864e5, iso = ms => new Date(ms).toISOString();
  const places = [
    ['np0', 'Sydney Park', 'park', -33.910951, 151.184444, 'St Peters', 'Big open park with wetlands and walking paths. Free to use.', 'p1', 1],
    ['np1', 'Centennial Park', 'park', -33.897933, 151.234773, 'Centennial Park', 'Large parklands with cycling and walking loops. Free to use.', 'p2', 1],
    ['np2', 'Royal Botanic Garden', 'park', -33.862768, 151.215713, 'Sydney', 'Botanic garden on the harbour. Free to visit.', 'p3', 1],
    ['np3', 'Barangaroo Reserve', 'park', -33.858491, 151.201165, 'Barangaroo', 'Harbourside headland park. Free to use.', 'p4', 1],
    ['np4', 'Rushcutters Bay Park', 'park', -33.875591, 151.229671, 'Rushcutters Bay', 'Harbourside park with open lawns. Free to use.', 'p5', 1],
    ['np5', 'Bicentennial Park', 'park', -33.844181, 151.078196, 'Sydney Olympic Park', 'Parkland and wetlands at Sydney Olympic Park. Free to use.', 'p6', 1],
    ['np6', 'Lake Parramatta Reserve', 'park', -33.793294, 151.008952, 'North Parramatta', 'Bush reserve around Lake Parramatta. Free to use.', 'p7', 1],
    ['np7', 'Bungarribee Park', 'park', -33.778982, 150.87173, 'Doonside', 'Part of the Western Sydney Parklands. Free to use.', 'p8', 1],
    ['np8', 'Nurragingy Reserve', 'park', -33.760998, 150.858926, 'Doonside', 'Large reserve with picnic areas. Free to use.', 'p9', 1],
    ['np9', 'Manly Dam', 'park', -33.782781, 151.253886, 'Allambie Heights', 'Bushland reserve around a freshwater lake. Free to use.', 'p10', 1],
    ['np10', 'Jamison Park', 'park', -33.766024, 150.691411, 'Penrith', 'Sports park in Penrith. Free to use.', 'p11', 1],
    ['np11', 'Gunnamatta Park', 'park', -34.059113, 151.149833, 'Cronulla', 'Bayside park in Cronulla. Free to use.', 'p1', 1],
    ['np12', 'Cook + Phillip Park Pool', 'pool', -33.873204, 151.213106, 'Sydney', 'Indoor public pool in the city. Check hours and entry prices with the centre.', 'p2', 0],
    ['np13', "Wylie's Baths", 'pool', -33.925677, 151.259417, 'Coogee', 'Historic ocean baths on the Coogee cliffs. Check entry with the baths.', 'p3', 0],
    ['np14', 'Sydney Olympic Park Aquatic Centre', 'pool', -33.850294, 151.067162, 'Sydney Olympic Park', 'Olympic venue with public pools. Check hours and entry prices with the centre.', 'p4', 0],
    ['np15', 'Ryde Aquatic Leisure Centre', 'pool', -33.821603, 151.119186, 'Ryde', 'Public pools and leisure centre. Check hours and entry prices with the centre.', 'p5', 0],
    ['np16', 'Parramatta Aquatic Centre', 'pool', -33.814837, 150.995091, 'Parramatta', 'Public pools and leisure centre. Check hours and entry prices with the centre.', 'p6', 0],
    ['np17', 'Whitlam Leisure Centre', 'pool', -33.92545, 150.914828, 'Liverpool', 'Public pools and leisure centre. Check hours and entry prices with the centre.', 'p7', 0],
    ['np18', 'Sutherland Leisure Centre', 'pool', -34.038249, 151.055934, 'Sutherland', 'Public pools and leisure centre. Check hours and entry prices with the centre.', 'p8', 0],
    ['np19', 'Blacktown Aquatic Centre', 'pool', -33.771794, 150.917929, 'Blacktown', 'Public pools. Check hours and entry prices with the centre.', 'p9', 0],
    ['np20', 'State Library of NSW', 'library', -33.866879, 151.212838, 'Sydney', 'Free to visit, with reading rooms and exhibitions.', 'p10', 1],
    ['np21', 'Customs House Library', 'library', -33.862135, 151.210928, 'Circular Quay', 'Public library at Circular Quay. Free entry.', 'p11', 1],
    ['np22', 'PHIVE', 'library', -33.815938, 151.004269, 'Parramatta', "Parramatta's civic and library building. Free entry.", 'p1', 1],
    ['np23', 'Penrith City Library', 'library', -33.750419, 150.689989, 'Penrith', 'Public library. Free entry.', 'p2', 1],
    ['np24', 'Casula Powerhouse Arts Centre', 'studio', -33.949421, 150.912843, 'Casula', 'Arts centre by the Georges River.', 'p3', 0],
    ['np25', 'Bankstown Arts Centre', 'studio', -33.918764, 151.03115, 'Bankstown', 'Community arts centre.', 'p4', 0]
  ];
  const S = [];
  places.forEach(([id, name, kind, lat, lng, suburb, desc, by, free], i) => {
    S.push(db.prepare('INSERT OR IGNORE INTO venues (id, name, kind, lat, lng, address, description, website, access, created_by, manager_id, manager_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?)')
      .bind(id, name, kind, lat, lng, suburb, desc, '[]', by, iso(NOW - (10 + i) * D)));
    if (free) S.push(db.prepare("INSERT OR IGNORE INTO venue_prices (id, venue_id, label, price, unit, note, created_by, updated_by, updated_at) VALUES (?, ?, 'Entry', 0, 'entry', 'Free to use', ?, ?, ?)")
      .bind('pr-' + id, id, by, by, iso(NOW - 3 * D)));
  });
  S.push(db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_places', ?)").bind(iso(NOW)));
  S.push(db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'"));
  await db.batch(S);
}

// Example events beyond the city (added 2026-10). Every spot was checked against the same
// public-space rules as a real pin. Runs once on an existing database; ids are fixed, so it's safe.
async function seedGreaterSydney(db) {
  const NOW = Date.now(), H = 3600e3, D = 864e5;
  const iso = ms => new Date(ms).toISOString();
  const at = h => { const d = new Date(NOW + h * H); d.setUTCMinutes(Math.round(d.getUTCMinutes() / 15) * 15, 0, 0); return iso(+d); };
  const S = [];
  const add = (sql, ...args) => S.push(db.prepare(sql).bind(...args));
  [['p8', 'Aarav', '25-35', 'man', 'Liverpool local. Dance, cricket and good chai.'],
   ['p9', 'Nina', '35-45', 'woman', 'Runs along the Nepean most evenings.'],
   ['p10', 'Kai', '18-25', 'non_binary', 'Beach person. Touch footy and ocean pools.'],
   ['p11', 'Grace', '55-65', 'woman', 'Retired art teacher. Sketchbook always in my bag.']]
    .forEach(([id, name, age, gender, bio]) => add('INSERT OR IGNORE INTO profiles (id, display_name, age_bracket, gender, bio, is_sample, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, name, age, gender, bio, iso(NOW - 45 * D)));
  [['v8', 'Hornsby Aquatic and Leisure Centre', 'pool', -33.70147, 151.096087, 'Hornsby', ['wheelchair', 'step_free', 'toilet', 'transport'], 'Indoor and outdoor pools near Hornsby station. (Example details, check with the centre.)', 'p2', null],
   ['v9', 'Cronulla Rock Pools', 'pool', -34.053753, 151.155626, 'Cronulla', ['toilet', 'transport'], 'Ocean rock pools at the end of Cronulla Beach. Free to use.', 'p10', 0],
   ['v10', 'Parramatta Park', 'park', -33.808196, 150.999125, 'Parramatta', ['wheelchair', 'step_free', 'toilet', 'shade', 'transport'], 'Big heritage park by the river. Free to use.', 'p3', 0]]
    .forEach(([id, name, kind, lat, lng, address, access, desc, by, free]) => {
      add('INSERT OR IGNORE INTO venues (id, name, kind, lat, lng, address, description, website, access, created_by, manager_id, manager_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?)', id, name, kind, lat, lng, address, desc, JSON.stringify(access), by, iso(NOW - 20 * D));
      if (free === 0) add('INSERT OR IGNORE INTO venue_prices (id, venue_id, label, price, unit, note, created_by, updated_by, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)', 'pr-' + id, id, 'Entry', 'entry', 'Free to use', by, by, iso(NOW - 5 * D));
    });
  const events = [
    ['p3', 'walktalk', 'wellbeing', 'Walk and talk around Parramatta Park', 20, 60, 15, -33.808196, 150.999125, 'Parramatta Park, Parramatta', 'quiet', ['wheelchair', 'step_free', 'shade', 'transport', 'newcomers'], 'A gentle loop, about 45 minutes. Come as you are.', 'v10', ['p7']],
    ['p9', 'running', 'move', 'Nepean riverside social run, all paces', 36, 60, 20, -33.748171, 150.676664, 'Regatta Park, Penrith', 'moderate', ['step_free', 'transport', 'newcomers', 'dogs'], 'Out and back along the river. Nobody gets left behind.', null, ['p2', 'p5']],
    ['p8', 'dance', 'move', 'Bollywood dance in Bigge Park', 54, 60, 25, -33.921791, 150.928105, 'Bigge Park, Liverpool', 'loud', ['step_free', 'transport', 'newcomers', 'kids'], 'Easy follow-along routines. No experience needed.', null, ['p1', 'p4']],
    ['p6', 'language', 'social', 'Language swap and chai', 30, 90, 12, -33.915608, 151.034793, 'Paul Keating Park, Bankstown', 'moderate', ['wheelchair', 'seating', 'transport', 'newcomers', 'alcohol_free'], 'Practise a language you are learning, help someone with yours.', null, ['p8']],
    ['p11', 'sketching', 'arts', 'Sketching in the Japanese garden', 75, 120, 10, -34.070267, 150.808264, 'Koshigaya Park, Campbelltown', 'quiet', ['seating', 'shade', 'newcomers', 'gear'], 'Spare pencils and paper to share. All skill levels.', null, ['p3']],
    ['p2', 'swimming', 'move', 'Early lap swim, all speeds', 44, 60, 8, -33.70147, 151.096087, 'Hornsby Aquatic and Leisure Centre, Hornsby', 'moderate', ['wheelchair', 'toilet', 'newcomers'], 'Pay your own entry at the desk.', 'v8', []],
    ['p10', 'touch', 'sport', 'Twilight touch footy at Manly Oval', 60, 90, 14, -33.796031, 151.284018, 'Manly Oval, Manly', 'moderate', ['toilet', 'transport', 'newcomers'], 'Mixed teams, friendly pace.', null, ['p2', 'p5', 'p6']],
    ['p10', 'colddip', 'wellbeing', 'Ocean pool dip and coffee', 90, 60, 12, -34.053753, 151.155626, 'Cronulla Rock Pools, Cronulla', 'moderate', ['toilet', 'transport', 'newcomers'], 'A quick dip, then coffee together.', 'v9', ['p9']]
  ];
  events.forEach(([host, act, cat, title, hours, dur, max, lat, lng, place, noise, access, notes, venue, people], i) => {
    const id = 'gs' + i;
    add(`INSERT OR IGNORE INTO events (id, host_id, activity, category, title, notes, meeting_point, skill, cost, max_people, starts_at, duration_mins, gender_rule, age_brackets, noise_level, access, venue_id, lat, lng, place, is_sample, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'All levels', NULL, ?, ?, ?, 'everyone', NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id, host, act, cat, title, notes, max, at(hours), dur, noise, JSON.stringify(access), venue, lat, lng, place, iso(NOW));
    [host, ...people].forEach(u => add('INSERT OR IGNORE INTO participants (event_id, user_id, joined_at) VALUES (?, ?, ?)', id, u, iso(NOW - H)));
  });
  add("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_greater', ?)", iso(NOW));
  add("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
  await db.batch(S);
}

async function seed(db) {
  const NOW = Date.now(), H = 3600e3, D = 864e5;
  const iso = ms => new Date(ms).toISOString();
  // Sydney time for "today" so example hours line up for local visitors
  const syd = new Date(new Date(NOW).toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const at = h => { const d = new Date(NOW + h * H); d.setUTCMinutes(Math.round(d.getUTCMinutes() / 15) * 15, 0, 0); return iso(+d); };
  const S = [];
  const add = (sql, ...args) => S.push(db.prepare(sql).bind(...args));

  const people = [
    ['p1', 'Priya', '25-35', 'woman', 'Knitter, chess fiend, oat flat white.'],
    ['p2', 'Tom', '18-25', 'man', 'Weekend hoops and Sunday swims.'],
    ['p3', 'Mei', '45-55', 'woman', 'Tai chi most mornings.'],
    ['p4', 'Sam', '18-25', 'non_binary', 'Uni student, ukulele, board games.'],
    ['p5', 'Jordan', '25-35', 'man', ''],
    ['p6', 'Aisha', '35-45', 'woman', 'Runs the Saturday beach clean-up.'],
    ['p7', 'Luca', '65-75', 'man', 'Retired teacher. Chess and birdwatching.']
  ];
  for (const [id, name, age, gender, bio] of people)
    add('INSERT OR IGNORE INTO profiles (id, display_name, age_bracket, gender, bio, is_sample, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, name, age, gender, bio, iso(NOW - 60 * D));

  const venues = [
    ['v1', 'Victoria Park Pool', 'pool', -33.88609, 151.192216, 'Camperdown', ['wheelchair', 'step_free', 'toilet', 'transport'], 'Outdoor 50m pool beside Lake Northam. (Example prices, check with the pool.)', 'p2', null, 0],
    ['v2', 'Ian Thorpe Aquatic Centre', 'pool', -33.877347, 151.198862, 'Ultimo', ['wheelchair', 'step_free', 'toilet', 'seating', 'transport'], 'Indoor pools and gym. (Example prices, check with the centre.)', 'p1', null, 0],
    ['v3', 'Prince Alfred Park basketball court', 'court', -33.887357, 151.204734, 'Surry Hills', ['step_free', 'transport'], 'Outdoor court in Prince Alfred Park. (Example hours.)', 'p5', 'p5', 1],
    ['v4', 'Glebe Town Hall', 'hall', -33.882576, 151.185091, 'Glebe', ['wheelchair', 'step_free', 'toilet', 'seating', 'transport'], 'Community hall with tables and chairs. (Example hours and prices.)', 'p3', 'p3', 0],
    ['v5', 'Prince Alfred Park tennis courts', 'court', -33.887726, 151.204228, 'Surry Hills', ['wheelchair', 'shade'], 'Public tennis courts.', 'p5', null, 0],
    ['v6', 'Victoria Park', 'park', -33.8852, 151.1930, 'Camperdown', ['wheelchair', 'step_free', 'toilet', 'shade', 'transport'], 'Big open lawns, Lake Northam and plenty of shady trees. Free to use.', 'p1', null, 0],
    ['v7', 'Bondi Beach', 'park', -33.8913, 151.2770, 'Bondi Beach', ['toilet', 'transport', 'shade'], 'Sydney\'s most famous beach. Swim between the flags.', 'p6', null, 0]
  ];
  for (const [id, name, kind, lat, lng, address, access, desc, by, mgr, ver] of venues)
    add('INSERT OR IGNORE INTO venues (id, name, kind, lat, lng, address, description, website, access, created_by, manager_id, manager_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      id, name, kind, lat, lng, address, desc, JSON.stringify(access), by, mgr, ver, iso(NOW - 30 * D));

  [['v1', 'Adult entry', 8.20, 'entry', null, 'p2'], ['v1', 'Child entry', 5.80, 'entry', 'Ages 3 to 15', 'p2'], ['v1', 'Concession', 5.80, 'entry', null, 'p1'],
   ['v1', 'Adult 10-visit pass', 73.80, 'pass', null, 'p2'], ['v1', 'Lane hire', 45, 'hour', 'Book at front desk', 'p6'],
   ['v2', 'Adult entry', 9.10, 'entry', null, 'p1'], ['v2', 'Concession', 6.40, 'entry', null, 'p1'], ['v4', 'Room hire', 35, 'hour', 'Community groups rate', 'p3'],
   ['v6', 'Entry', 0, 'entry', 'Free to use', 'p1'], ['v7', 'Entry', 0, 'entry', 'Free to use', 'p6']]
    .forEach(([v, label, price, unit, note, by], i) => add('INSERT OR IGNORE INTO venue_prices (id, venue_id, label, price, unit, note, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'pr' + i, v, label, price, unit, note, by, by, iso(NOW - (i + 2) * D)));

  [['v3', [1, 2, 3, 4, 5], '16:00', '20:00', 'Bring your own ball.'], ['v3', [0, 6], '08:00', '17:00', null], ['v4', [2, 4], '10:00', '14:00', 'Main hall, free for community groups'], ['v4', [syd.getDay()], '12:00', '16:00', 'Side room free today']]
    .forEach(([v, days, a, b, note], i) => add('INSERT OR IGNORE INTO venue_slots (id, venue_id, days, start_time, end_time, note, posted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)', 'sl' + i, v, JSON.stringify(days), a, b, note, iso(NOW)));

  [['v1', 'p2', 5, 'Best outdoor pool in the inner west. Slow lane is genuinely slow, which I love.', 6], ['v1', 'p6', 4, 'Gets busy after 5 in summer. Change rooms are clean and step-free.', 21],
   ['v3', 'p5', 4, 'Good rims, lights on until 8. Floor is a bit slippery after rain.', 3], ['v4', 'p1', 5, 'Lovely warm hall for board games. Plenty of tables and an accessible loo.', 10]]
    .forEach(([v, u, r, body, ago], i) => add('INSERT OR IGNORE INTO reviews (id, venue_id, user_id, rating, body, photo, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', 'rv' + i, v, u, r, body, iso(NOW - ago * D)));

  const events = [
    ['p1', 'knitting', 'arts', 'Stitch and chat under the fig tree', 2, 120, 12, -33.885935, 151.193935, 'Victoria Park, Camperdown', 'quiet', ['wheelchair', 'seating', 'shade', 'newcomers', 'sensory'], 'On the lawn near Lake Northam', 'Spare needles and wool to share. Total beginners welcome.', null, ['p3', 'p7']],
    ['p7', 'chess', 'games', 'Chess in the park', 5, 180, 10, -33.8716, 151.2116, 'Hyde Park, Sydney', 'quiet', ['wheelchair', 'seating', 'transport', 'gear', 'newcomers'], 'Giant chessboard near the Archibald Fountain', null, null, ['p4']],
    ['p6', 'dance', 'move', 'Outdoor hour of dance', 26, 60, 30, -33.8682, 151.2142, 'The Domain, Sydney', 'loud', ['step_free', 'transport', 'newcomers', 'kids'], 'Near the big Moreton Bay fig', 'Bluetooth speaker, easy follow-along moves.', null, ['p1', 'p4', 'p5']],
    ['p2', 'basketball', 'sport', 'After-work pickup hoops', 30, 90, 10, -33.887357, 151.204734, 'Prince Alfred Park basketball court, Surry Hills', 'moderate', ['step_free'], 'Courtside', null, 'v3', ['p5']],
    ['p3', 'taichi', 'move', 'Gentle morning tai chi', 44, 60, 20, -33.8975, 151.2340, 'Centennial Park, Centennial Park', 'quiet', ['wheelchair', 'step_free', 'shade', 'newcomers'], null, null, null, ['p7']],
    ['p6', 'cleanup', 'outdoors', 'Saturday beach clean-up', 70, 120, 40, -33.8915, 151.2767, 'Bondi Beach, Bondi Beach', 'moderate', ['toilet', 'transport', 'kids', 'dogs', 'gear'], 'Outside the Pavilion', 'Gloves and bags provided.', null, ['p2', 'p1']],
    ['p4', 'jam', 'music', 'Acoustic jam, bring an instrument', 54, 120, 15, -33.894161, 151.179368, 'Camperdown Memorial Rest Park, Newtown', 'loud', ['shade', 'alcohol_free'], null, null, null, ['p5']],
    ['p1', 'boardgames', 'games', 'Board games and tea', 78, 180, 16, -33.882576, 151.185091, 'Glebe Town Hall, Glebe', 'moderate', ['wheelchair', 'toilet', 'seating', 'gear', 'alcohol_free'], null, null, 'v4', ['p4', 'p7']],
    ['p2', 'swimming', 'move', 'Slow lane social swim', 100, 60, 8, -33.88609, 151.192216, 'Victoria Park Pool, Camperdown', 'moderate', ['wheelchair', 'toilet', 'newcomers'], null, 'Pay your own entry at the desk. All speeds welcome.', 'v1', []],
    ['p7', 'birdwatching', 'outdoors', 'Dawn birdwatching', 120, 90, 8, -33.872212, 151.178507, 'Bicentennial Park, Glebe', 'quiet', ['step_free'], null, null, null, ['p3']]
  ];
  events.forEach(([host, act, cat, title, hours, dur, max, lat, lng, place, noise, access, meet, notes, venue, people], i) => {
    const id = 'ex' + i;
    add(`INSERT OR IGNORE INTO events (id, host_id, activity, category, title, notes, meeting_point, skill, cost, max_people, starts_at, duration_mins, gender_rule, age_brackets, noise_level, access, venue_id, lat, lng, place, is_sample, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'All levels', NULL, ?, ?, ?, 'everyone', NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id, host, act, cat, title, notes, meet, max, at(hours), dur, noise, JSON.stringify(access), venue, lat, lng, place, iso(NOW));
    [host, ...people].forEach(u => add('INSERT OR IGNORE INTO participants (event_id, user_id, joined_at) VALUES (?, ?, ?)', id, u, iso(NOW - H)));
  });
  add("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', '1')");
  add("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', ?)", iso(NOW));
  await db.batch(S);
}
