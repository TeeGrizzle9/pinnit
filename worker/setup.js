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
CREATE INDEX IF NOT EXISTS restore_attempts_idx ON restore_attempts(ip, at);
`;

// Columns added after launch. CREATE TABLE IF NOT EXISTS won't add them to an existing table,
// so add any that are missing (existing data is kept).
const ADDED_COLUMNS = [['profiles', 'recovery_hash', 'TEXT']];
async function migrate(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!results.some(c => c.name === col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS profiles_recovery_idx ON profiles(recovery_hash)').run();
}

let ready = null;
export function ensureReady(db) {
  if (!ready) ready = setup(db).catch(e => { ready = null; throw e; });
  return ready;
}
async function setup(db) {
  await db.batch(SCHEMA.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await migrate(db);
  const seeded = await db.prepare("SELECT value FROM meta WHERE key = 'seeded'").first();
  if (!seeded) await seed(db);
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
