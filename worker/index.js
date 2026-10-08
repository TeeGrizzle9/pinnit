// Pinnit API: a Cloudflare Worker in front of a D1 (SQLite) database.
// Everything under /api/* comes here; every other path is a static file (index.html, brand/, â€¦).
// Accounts are phone-based: creating one returns a random token the app keeps in localStorage,
// and only a SHA-256 hash of it is stored here.
import { ensureReady } from './setup.js';
import { checkSpot, inSydney, SPOT_MESSAGES } from '../public/spot-rules.js';
import { findBadLanguage, languageMessage } from '../public/moderation.js';

// Language check on anything other people will read. First a word filter (instant, catches swearing,
// slurs and sexual terms even when disguised), then Cloudflare's Llama Guard model for things a word
// list misses, like sexual suggestions or threats in ordinary words. If the AI is unavailable the
// word filter still applies. Blocked attempts are logged in moderation_log for the team to review.
const AI_BLOCK = { S1: 'violence', S2: 'crime', S3: 'sexual crime', S4: 'child safety', S10: 'hate', S12: 'sexual content' };
async function moderate(ctx, what, ...texts) {
  const text = texts.filter(Boolean).join('\n').trim();
  if (!text) return;
  let reason = findBadLanguage(text) ? 'language' : null;
  if (!reason && ctx.env.AI && text.length > 2) {
    try {
      const r = await ctx.env.AI.run('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: text.slice(0, 1500) }] });
      const out = r && (r.response ?? r.result?.response ?? r);
      const unsafe = typeof out === 'object' ? out.safe === false : /unsafe/i.test(String(out));
      const cats = typeof out === 'object' ? (out.categories || []) : String(out).match(/S\d+/g) || [];
      const hit = cats.map(c => String(c).toUpperCase()).find(c => AI_BLOCK[c]);
      if (unsafe && hit) reason = AI_BLOCK[hit];
    } catch (e) { console.warn('AI moderation unavailable', e && e.message); }
  }
  if (!reason) return;
  try {
    await ctx.db.prepare('INSERT INTO moderation_log (id, user_id, kind, reason, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uuid(), ctx.me, what, reason, text.slice(0, 300), now()).run();
  } catch {}
  fail(422, languageMessage(...(WHAT[what] || ['This'])));
}
const WHAT = { message: ['Your message', 'sent'], event: ['Your event', 'posted'], place: ['This place', 'saved'], price: ['This price', 'saved'], hours: ['These hours', 'saved'], review: ['Your review', 'posted'], profile: ['Your profile', 'saved'], name: ['That name', 'saved'] };

// map tiles are cached at Cloudflare's edge for a day, so checks are fast after the first one
const edgeFetch = (url, init) => fetch(url, { ...init, cf: { cacheTtl: 86400, cacheEverything: true } });
// a venue already on Pinnit counts as a checked public space; otherwise read the map data
async function verifySpot(db, lat, lng, type) {
  if (!inSydney(lat, lng)) return { ok: false, reason: 'outside' };
  if (type !== 'venue') {
    const { results } = await db.prepare('SELECT id, name, kind, lat, lng FROM venues WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
      .bind(lat - 0.0005, lat + 0.0005, lng - 0.0006, lng + 0.0006).all();
    const v = results.find(v => Math.hypot((v.lat - lat) * 111000, (v.lng - lng) * 92000) <= 50);
    if (v) return { ok: true, kind: v.kind, name: v.name, venue_id: v.id };
  }
  return checkSpot(lat, lng, edgeFetch);
}

/* ---------- allowed values (mirror index.html) ---------- */
const AGES = ['18-25', '25-35', '35-45', '45-55', '55-65', '65-75', '75+'];
const GENDERS = ['woman', 'man', 'non_binary', 'prefer_not'];
const RULES = ['everyone', 'women', 'women_nb', 'men'];
const CATS = ['sport', 'move', 'arts', 'music', 'games', 'outdoors', 'wellbeing', 'social'];
const NOISE = ['quiet', 'moderate', 'loud'];
const SKILLS = ['All levels', 'Beginner', 'Intermediate', 'Advanced'];
const ACCESS = ['wheelchair', 'step_free', 'toilet', 'seating', 'shade', 'transport', 'parking', 'auslan', 'newcomers', 'sensory', 'kids', 'dogs', 'alcohol_free', 'gear'];
const VENUE_ACCESS = ACCESS.slice(0, 8);
const VKINDS = ['pool', 'court', 'field', 'park', 'hall', 'school', 'gym', 'studio', 'library', 'cafe', 'other'];
const UNITS = ['entry', 'hour', 'session', 'pass', 'month', 'year'];
const REPORT_KINDS = ['person', 'event', 'review'];
const FEELS = ['yes', 'unsure', 'no'];
const PUBLIC = 'id, display_name, avatar_url, age_bracket, gender, bio, is_sample, created_at';
const H = 3600e3, D = 864e5;

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200) => new Response(JSON.stringify(data ?? null), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const str = (v, max, { required = false, min = 0, name = 'text' } = {}) => {
  if (v == null || v === '') { if (required) fail(400, `Add a ${name}`); return null; }
  const s = String(v).trim();
  if (required && !s) fail(400, `Add a ${name}`);
  if (s.length < min || s.length > max) fail(400, `That ${name} is too ${s.length < min ? 'short' : 'long'}`);
  return s || null;
};
const oneOf = (v, list, name, fallback) => { if (v == null || v === '') { if (fallback !== undefined) return fallback; fail(400, `Pick a ${name}`); } if (!list.includes(v)) fail(400, `That ${name} isn't valid`); return v; };
const listOf = (v, list) => { if (v == null) return []; if (!Array.isArray(v) || v.some(x => !list.includes(x))) fail(400, 'Some options are not valid'); return [...new Set(v)]; };
const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) fail(400, `Check the ${name}`); return n; };
const parseJ = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const pair = (x, y) => x < y ? [x, y] : [y, x];
async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const randomToken = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };
const refCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.getRandomValues(new Uint8Array(1))[0] % 32]).join('');
const inList = n => Array(n).fill('?').join(',');
// every write bumps a version number, so phones polling /api/pulse know to reload
const bump = db => db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
async function write(db, stmts) { await db.batch([...stmts, bump(db)]); }
async function countSince(db, sql, ...args) { return (await db.prepare(sql).bind(...args).first('n')) || 0; }
const profileOut = p => p && { ...p, is_sample: !!p.is_sample };

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

// accounts
route('POST', '/api/account', async ctx => {
  const { db, body } = ctx;
  const display_name = str(body.display_name, 30, { required: true, name: 'first name' });
  await moderate(ctx, 'name', display_name);
  const age_bracket = oneOf(body.age_bracket, AGES, 'age range');
  const gender = oneOf(body.gender, GENDERS, 'gender', 'prefer_not');
  const id = uuid(), token = randomToken();
  let code = refCode();
  for (let i = 0; i < 5 && await db.prepare('SELECT 1 FROM profiles WHERE referral_code = ?').bind(code).first(); i++) code = refCode();
  await write(db, [db.prepare('INSERT INTO profiles (id, token_hash, display_name, age_bracket, gender, bio, referral_code, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .bind(id, await sha256(token), display_name, age_bracket, gender, code, now())]);
  return { id, token };
}, { public: true });
// Recovery codes: 12 characters from an alphabet with no look-alikes (no O/0, I/1), shown as XXXX-XXXX-XXXX.
// Only a hash is stored. Making a new code replaces the old one.
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = () => { const b = crypto.getRandomValues(new Uint8Array(12)); return [...b].map(x => CODE_ABC[x % 32]).join(''); };
route('POST', '/api/me/recovery', async ({ db, me }) => {
  const code = newCode();
  await db.prepare('UPDATE profiles SET recovery_hash = ? WHERE id = ?').bind(await sha256('recovery:' + code), me).run();
  return { code: code.match(/.{4}/g).join('-') };
});
route('GET', '/api/me/recovery', async ({ db, me }) => ({ saved: !!(await db.prepare('SELECT recovery_hash FROM profiles WHERE id = ?').bind(me).first('recovery_hash')) }));
// moving an account to this phone: a fresh key is issued, which signs the account out everywhere else
route('POST', '/api/recover', async ({ db, body, req }) => {
  const ip = req.headers.get('CF-Connecting-IP') || 'local', hourAgo = new Date(Date.now() - H).toISOString();
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM restore_attempts WHERE ip = ? AND at > ?', ip, hourAgo) >= 8) fail(429, 'Too many tries. Wait an hour and try again');
  await db.batch([db.prepare('INSERT INTO restore_attempts (ip, at) VALUES (?, ?)').bind(ip, now()), db.prepare('DELETE FROM restore_attempts WHERE at < ?').bind(new Date(Date.now() - D).toISOString())]);
  const code = normCode(body.code);
  if (code.length !== 12) fail(400, 'Recovery codes have 12 letters and numbers, like K7QM-2XRT-9HWP');
  const p = await db.prepare('SELECT id FROM profiles WHERE recovery_hash = ?').bind(await sha256('recovery:' + code)).first();
  if (!p) fail(404, "That code didn't match an account. Check it and try again");
  const token = randomToken();
  await db.prepare('UPDATE profiles SET token_hash = ? WHERE id = ?').bind(await sha256(token), p.id).run();
  return { id: p.id, token };
}, { public: true });
// restore an account from the backup cookie when the browser has lost its saved key
route('GET', '/api/session', async ({ db, req }) => {
  const m = /(?:^|;\s*)pinnit_key=([0-9a-f]{64})/.exec(req.headers.get('Cookie') || '');
  if (!m) return { none: true };
  const p = await db.prepare('SELECT id FROM profiles WHERE token_hash = ?').bind(await sha256(m[1])).first();
  return p ? { id: p.id, token: m[1] } : { none: true };
}, { public: true });
route('GET', '/api/me', async ({ db, me }) => profileOut(await db.prepare(`SELECT ${PUBLIC}, referral_code FROM profiles WHERE id = ?`).bind(me).first()));
route('PATCH', '/api/me', async ctx => {
  const { db, me, body } = ctx;
  const cur = await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(me).first();
  await moderate(ctx, 'profile', 'display_name' in body ? body.display_name : '', 'bio' in body ? body.bio : '');
  const next = {
    display_name: 'display_name' in body ? str(body.display_name, 30, { required: true, name: 'first name' }) : cur.display_name,
    bio: 'bio' in body ? str(body.bio, 160) : cur.bio,
    age_bracket: 'age_bracket' in body ? oneOf(body.age_bracket, AGES, 'age range') : cur.age_bracket,
    gender: 'gender' in body ? oneOf(body.gender, GENDERS, 'gender') : cur.gender,
    avatar_url: 'avatar_url' in body ? (body.avatar_url == null ? null : String(body.avatar_url).match(/^\/api\/photo\/[\w-]+$/) ? body.avatar_url : fail(400, 'Bad photo')) : cur.avatar_url
  };
  await write(db, [db.prepare('UPDATE profiles SET display_name = ?, bio = ?, age_bracket = ?, gender = ?, avatar_url = ? WHERE id = ?').bind(next.display_name, next.bio, next.age_bracket, next.gender, next.avatar_url, me)]);
  return profileOut(await db.prepare(`SELECT ${PUBLIC}, referral_code FROM profiles WHERE id = ?`).bind(me).first());
});
// delete everything this person made (reports they filed are kept, without their name, for moderation)
route('DELETE', '/api/me', async ({ db, me }) => {
  const mine = 'SELECT id FROM events WHERE host_id = ?';
  await write(db, [
    db.prepare(`DELETE FROM participants WHERE user_id = ? OR event_id IN (${mine})`).bind(me, me),
    db.prepare(`DELETE FROM messages WHERE user_id = ? OR event_id IN (${mine})`).bind(me, me),
    db.prepare(`DELETE FROM checkins WHERE user_id = ? OR event_id IN (${mine})`).bind(me, me),
    db.prepare('DELETE FROM events WHERE host_id = ?').bind(me),
    db.prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?').bind(me, me),
    db.prepare('DELETE FROM reviews WHERE user_id = ?').bind(me),
    db.prepare('DELETE FROM photos WHERE owner_id = ?').bind(me),
    db.prepare('DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?').bind(me, me),
    db.prepare('DELETE FROM safety WHERE user_id = ?').bind(me),
    db.prepare('DELETE FROM badges WHERE user_id = ?').bind(me),
    db.prepare('UPDATE reports SET reporter_id = NULL WHERE reporter_id = ?').bind(me),
    db.prepare('UPDATE venues SET manager_id = NULL, manager_verified = 0 WHERE manager_id = ?').bind(me),
    db.prepare('DELETE FROM profiles WHERE id = ?').bind(me)
  ]);
  return { ok: true };
});
route('GET', '/api/profiles/:id', async ({ db, params }) => profileOut(await db.prepare(`SELECT ${PUBLIC} FROM profiles WHERE id = ?`).bind(params.id).first()));

// photos: stored in D1, served with long caching (ids are random and never reused)
route('POST', '/api/photos', async ({ db, me, body }) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.data || '');
  if (!m) fail(400, 'That photo could not be read');
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > 700 * 1024) fail(400, 'That photo is too big');
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM photos WHERE owner_id = ? AND created_at > ?', me, new Date(Date.now() - D).toISOString()) >= 40) fail(429, "You've added a lot of photos today. Try again tomorrow");
  const id = uuid();
  await db.prepare('INSERT INTO photos (id, owner_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, me, m[1], bytes, now()).run();
  return { url: '/api/photo/' + id };
});
route('GET', '/api/photo/:id', async ({ db, params }) => {
  const p = await db.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(params.id).first();
  if (!p) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(p.data), { headers: { 'Content-Type': p.mime, 'Cache-Control': 'public, max-age=31536000, immutable' } });
}, { public: true, raw: true });

// events
let lastRoll = 0;
// example events repeat weekly, so the map always has something on
async function rollSamples(db) {
  if (Date.now() - lastRoll < 60e3) return;
  lastRoll = Date.now();
  const { results } = await db.prepare('SELECT id, starts_at, duration_mins FROM events WHERE is_sample = 1').all();
  const stmts = [];
  for (const e of results) {
    let s = Date.parse(e.starts_at);
    if (s + e.duration_mins * 60e3 > Date.now()) continue;
    while (s + e.duration_mins * 60e3 <= Date.now()) s += 7 * D;
    stmts.push(db.prepare('UPDATE events SET starts_at = ? WHERE id = ?').bind(new Date(s).toISOString(), e.id),
      db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id NOT IN (SELECT id FROM profiles WHERE is_sample = 1)').bind(e.id),
      db.prepare('DELETE FROM messages WHERE event_id = ?').bind(e.id),
      db.prepare('DELETE FROM checkins WHERE event_id = ?').bind(e.id));
  }
  if (stmts.length) await write(db, stmts);
}
const eventOut = (e, people, parts) => ({
  ...e, is_sample: !!e.is_sample, age_brackets: parseJ(e.age_brackets), access: parseJ(e.access) || [],
  host: people.get(e.host_id) || null,
  participants: parts.filter(p => p.event_id === e.id).map(p => ({ user_id: p.user_id, joined_at: p.joined_at, arrived_at: p.arrived_at, first_timer: !!p.first_timer, profile: people.get(p.user_id) || null }))
});
route('GET', '/api/events', async ({ db, me }) => {
  await rollSamples(db);
  // events disappear the moment they finish
  const live = "julianday(e.starts_at) + e.duration_mins / 1440.0 > julianday('now')";
  const blocked = 'SELECT blocked_id FROM blocks WHERE user_id = ?';
  const [ev, parts, people] = await db.batch([
    db.prepare(`SELECT e.* FROM events e WHERE ${live} AND e.host_id NOT IN (${blocked}) ORDER BY e.starts_at LIMIT 500`).bind(me),
    db.prepare(`SELECT pa.*, NOT EXISTS (SELECT 1 FROM participants x WHERE x.user_id = pa.user_id AND x.joined_at < pa.joined_at) AS first_timer FROM participants pa JOIN events e ON e.id = pa.event_id WHERE ${live}`),
    db.prepare(`SELECT ${PUBLIC} FROM profiles WHERE id IN (SELECT pa.user_id FROM participants pa JOIN events e ON e.id = pa.event_id WHERE ${live})`)
  ]);
  const map = new Map(people.results.map(p => [p.id, profileOut(p)]));
  return ev.results.map(e => eventOut(e, map, parts.results));
});
route('POST', '/api/check-spot', async ({ db, body }) => {
  try { return await verifySpot(db, Number(body.lat), Number(body.lng), body.type || 'event'); }
  catch (e) { console.error('spot check', e); return { ok: false, reason: 'unavailable' }; }
});
async function placeOrFail(db, lat, lng, type) {
  let spot;
  try { spot = await verifySpot(db, lat, lng, type); }
  catch (e) { console.error('spot check', e); fail(503, SPOT_MESSAGES.unavailable); }
  if (!spot.ok) fail(422, SPOT_MESSAGES[spot.reason] || SPOT_MESSAGES.private);
  return spot;
}
route('POST', '/api/events', async ctx => {
  const { db, me, body } = ctx;
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM events WHERE host_id = ? AND created_at > ?', me, new Date(Date.now() - D).toISOString()) >= 10) fail(429, "You've posted 10 events today. Try again tomorrow");
  const lat = num(body.lat, -90, 90, 'location'), lng = num(body.lng, -180, 180, 'location');
  if (!inSydney(lat, lng)) fail(422, SPOT_MESSAGES.outside);
  const start = Date.parse(body.starts_at);
  if (!Number.isFinite(start) || start < Date.now() - 10 * 60e3) fail(400, 'That start time has already passed');
  if (start > Date.now() + 31 * D) fail(400, 'Events can be up to 30 days ahead');
  const category = oneOf(body.category, CATS, 'category');
  const activity = String(body.activity || ''); if (!/^[a-z_]{2,24}$/.test(activity)) fail(400, "Pick what's on");
  const title = str(body.title, 60, { name: 'title' });
  if (activity === 'other' && !title) fail(400, 'Give your event a name so people know what it is');
  const ages = body.age_brackets ? listOf(body.age_brackets, AGES) : [];
  const access = listOf(body.access, ACCESS);
  await moderate(ctx, 'event', title, body.notes, body.meeting_point);
  const spot = await placeOrFail(db, lat, lng, 'event');
  let venue_id = body.venue_id ? String(body.venue_id) : (spot.venue_id || null);
  if (venue_id && !await db.prepare('SELECT 1 FROM venues WHERE id = ?').bind(venue_id).first()) venue_id = null;
  const id = uuid(), t = now();
  await write(db, [
    db.prepare(`INSERT INTO events (id, host_id, activity, category, title, notes, meeting_point, skill, cost, max_people, starts_at, duration_mins, gender_rule, age_brackets, noise_level, access, venue_id, lat, lng, place, is_sample, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).bind(
      id, me, activity, category, title, str(body.notes, 500, { name: 'note' }), str(body.meeting_point, 160, { name: 'meeting point' }),
      body.skill == null ? null : oneOf(body.skill, SKILLS, 'level'), body.cost == null || body.cost === '' ? null : num(body.cost, 0, 1000, 'cost'),
      Math.round(num(body.max_people, 2, 100, 'number of people')), new Date(Math.max(start, Date.now())).toISOString(),
      Math.round(num(body.duration_mins, 15, 720, 'length')), oneOf(body.gender_rule, RULES, 'who can join', 'everyone'),
      ages.length ? JSON.stringify(ages) : null, body.noise_level ? oneOf(body.noise_level, NOISE, 'noise level') : null,
      access.length ? JSON.stringify(access) : null, venue_id, lat, lng, str(body.place, 160, { required: true, name: 'place' }), t),
    db.prepare('INSERT INTO participants (event_id, user_id, joined_at) VALUES (?, ?, ?)').bind(id, me, t)
  ]);
  return { id };
});
const getEvent = async (db, id) => (await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first()) || fail(404, 'That event has finished');
const isParticipant = async (db, id, me) => !!await db.prepare('SELECT 1 FROM participants WHERE event_id = ? AND user_id = ?').bind(id, me).first();
route('DELETE', '/api/events/:id', async ({ db, me, params }) => {
  const e = await getEvent(db, params.id);
  if (e.host_id !== me) fail(403, 'Only the host can cancel this event');
  await write(db, ['participants', 'messages', 'checkins'].map(t => db.prepare(`DELETE FROM ${t} WHERE event_id = ?`).bind(e.id)).concat(db.prepare('DELETE FROM events WHERE id = ?').bind(e.id)));
  return { ok: true };
});
route('POST', '/api/events/:id/join', async ({ db, me, params }) => {
  const e = await getEvent(db, params.id);
  if (Date.parse(e.starts_at) + e.duration_mins * 60e3 < Date.now()) fail(400, 'This event has finished');
  const prof = await db.prepare('SELECT age_bracket, gender FROM profiles WHERE id = ?').bind(me).first();
  const ages = parseJ(e.age_brackets) || [];
  if (ages.length && !ages.includes(prof.age_bracket)) fail(403, 'This event is for a different age range');
  if ((e.gender_rule === 'women' && prof.gender !== 'woman') || (e.gender_rule === 'men' && prof.gender !== 'man') || (e.gender_rule === 'women_nb' && !['woman', 'non_binary'].includes(prof.gender))) fail(403, "This event isn't open to you");
  if (await db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').bind(e.host_id, me).first()) fail(403, "You can't join this event");
  const n = await countSince(db, 'SELECT COUNT(*) AS n FROM participants WHERE event_id = ?', e.id);
  if (n >= e.max_people && !await isParticipant(db, e.id, me)) fail(409, 'This event is full');
  await write(db, [db.prepare('INSERT OR IGNORE INTO participants (event_id, user_id, joined_at) VALUES (?, ?, ?)').bind(e.id, me, now())]);
  return { ok: true };
});
route('DELETE', '/api/events/:id/join', async ({ db, me, params }) => {
  await write(db, [db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?').bind(params.id, me), db.prepare('DELETE FROM checkins WHERE event_id = ? AND user_id = ?').bind(params.id, me)]);
  return { ok: true };
});
route('POST', '/api/events/:id/arrived', async ({ db, me, params }) => {
  await write(db, [db.prepare('UPDATE participants SET arrived_at = ? WHERE event_id = ? AND user_id = ?').bind(now(), params.id, me)]);
  return { ok: true };
});
// group chat: only people in the event can read or post
route('GET', '/api/events/:id/messages', async ({ db, me, params, url }) => {
  if (!await isParticipant(db, params.id, me)) fail(403, 'Join the event to see the chat');
  const after = url.searchParams.get('after') || '';
  const { results } = await db.prepare('SELECT * FROM messages WHERE event_id = ? AND created_at > ? AND user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?) ORDER BY created_at LIMIT 300')
    .bind(params.id, after, me).all();
  return results;
});
route('POST', '/api/events/:id/messages', async ctx => {
  const { db, me, params, body } = ctx;
  if (!await isParticipant(db, params.id, me)) fail(403, 'Join the event to chat');
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND created_at > ?', me, new Date(Date.now() - 60e3).toISOString()) >= 15) fail(429, 'Slow down a little');
  const m = { id: uuid(), event_id: params.id, user_id: me, body: str(body.body, 500, { required: true, name: 'message' }), created_at: now() };
  await moderate(ctx, 'message', m.body);
  await write(db, [db.prepare('INSERT INTO messages (id, event_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(m.id, m.event_id, m.user_id, m.body, m.created_at)]);
  return m;
});
route('GET', '/api/events/:id/checkins', async ({ db, me, params }) => {
  if (!await isParticipant(db, params.id, me)) return [];
  return (await db.prepare('SELECT * FROM checkins WHERE event_id = ?').bind(params.id).all()).results;
});
route('PUT', '/api/events/:id/checkin', async ({ db, me, params, body }) => {
  if (!await isParticipant(db, params.id, me)) fail(403, 'Join the event first');
  await db.prepare('INSERT OR REPLACE INTO checkins (event_id, user_id, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?)').bind(params.id, me, num(body.lat, -90, 90, 'location'), num(body.lng, -180, 180, 'location'), now()).run();
  return { ok: true };
});
route('DELETE', '/api/events/:id/checkin', async ({ db, me, params }) => {
  await db.prepare('DELETE FROM checkins WHERE event_id = ? AND user_id = ?').bind(params.id, me).run();
  return { ok: true };
});

// friends
route('GET', '/api/friendships', async ({ db, me }) => {
  const { results } = await db.prepare('SELECT * FROM friendships WHERE (user_a = ? OR user_b = ?) AND NOT EXISTS (SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id IN (friendships.user_a, friendships.user_b))').bind(me, me, me).all();
  const ids = [...new Set(results.flatMap(f => [f.user_a, f.user_b]))];
  const people = ids.length ? (await db.prepare(`SELECT ${PUBLIC} FROM profiles WHERE id IN (${inList(ids.length)})`).bind(...ids).all()).results : [];
  const map = new Map(people.map(p => [p.id, profileOut(p)]));
  return results.map(f => ({ ...f, a: map.get(f.user_a) || null, b: map.get(f.user_b) || null }));
});
async function requestFriend(db, me, other) {
  if (other === me) fail(400, "That's you");
  if (!await db.prepare('SELECT 1 FROM profiles WHERE id = ?').bind(other).first()) fail(404, 'No one has that code');
  const [a, b] = pair(me, other);
  const f = await db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b).first();
  if (f) {
    if (f.status === 'pending' && f.requested_by !== me) { await write(db, [db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ?").bind(now(), a, b)]); return 'accepted'; }
    return f.status === 'accepted' ? 'friends' : 'pending';
  }
  await write(db, [db.prepare("INSERT INTO friendships (user_a, user_b, status, requested_by, updated_at) VALUES (?, ?, 'pending', ?, ?)").bind(a, b, me, now())]);
  return 'requested';
}
route('POST', '/api/friends/code', async ({ db, me, body }) => {
  const p = await db.prepare('SELECT id FROM profiles WHERE referral_code = ?').bind(String(body.code || '').trim().toUpperCase()).first();
  if (!p || p.id === me) fail(404, 'No one has that code');
  return { result: await requestFriend(db, me, p.id) };
});
route('POST', '/api/friends/:id', async ({ db, me, params }) => ({ result: await requestFriend(db, me, params.id) }));
route('DELETE', '/api/friends/:id', async ({ db, me, params }) => {
  const [a, b] = pair(me, params.id);
  await write(db, [db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b)]);
  return { ok: true };
});
route('GET', '/api/recent', async ({ db, me }) => {
  const { results } = await db.prepare(`
    SELECT p.id, p.display_name, p.avatar_url, p.age_bracket, p.gender, p.bio, p.is_sample, COALESCE(e.title, e.activity) AS last_event, MAX(e.starts_at) AS last_played
    FROM participants mine JOIN events e ON e.id = mine.event_id JOIN participants o ON o.event_id = e.id AND o.user_id != mine.user_id JOIN profiles p ON p.id = o.user_id
    WHERE mine.user_id = ? AND e.starts_at < ? AND p.id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
    GROUP BY p.id ORDER BY last_played DESC LIMIT 8`).bind(me, now(), me).all();
  return results.map(profileOut);
});

// venues, prices, community hours, reviews
route('GET', '/api/venues', async ({ db, me }) => {
  const [v, pr, sl, rv, people] = await db.batch([
    db.prepare('SELECT * FROM venues LIMIT 1000'),
    db.prepare('SELECT * FROM venue_prices'),
    db.prepare('SELECT * FROM venue_slots'),
    db.prepare('SELECT * FROM reviews WHERE user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?) ORDER BY created_at DESC').bind(me),
    db.prepare(`SELECT ${PUBLIC} FROM profiles WHERE id IN (SELECT manager_id FROM venues UNION SELECT created_by FROM venues UNION SELECT updated_by FROM venue_prices UNION SELECT user_id FROM reviews)`)
  ]);
  const map = new Map(people.results.map(p => [p.id, profileOut(p)]));
  return v.results.map(x => ({
    ...x, access: parseJ(x.access) || [], manager_verified: !!x.manager_verified, manager: map.get(x.manager_id) || null, creator: map.get(x.created_by) || null,
    venue_prices: pr.results.filter(p => p.venue_id === x.id).map(p => ({ ...p, updater: map.get(p.updated_by) || null })),
    venue_slots: sl.results.filter(s => s.venue_id === x.id).map(s => ({ ...s, days: parseJ(s.days) || [] })),
    venue_reviews: rv.results.filter(r => r.venue_id === x.id).map(r => ({ ...r, author: map.get(r.user_id) || null }))
  }));
});
const getVenue = async (db, id) => (await db.prepare('SELECT * FROM venues WHERE id = ?').bind(id).first()) || fail(404, 'That venue was removed');
const venueFields = body => ({
  name: str(body.name, 80, { required: true, min: 2, name: 'venue name' }), kind: oneOf(body.kind, VKINDS, 'venue type'),
  access: JSON.stringify(listOf(body.access, VENUE_ACCESS)), description: str(body.description, 400, { name: 'description' }), website: str(body.website, 200, { name: 'website' })
});
route('POST', '/api/venues', async ctx => {
  const { db, me, body } = ctx;
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM venues WHERE created_by = ? AND created_at > ?', me, new Date(Date.now() - D).toISOString()) >= 10) fail(429, "You've added a lot of venues today. Try again tomorrow");
  const lat = num(body.lat, -90, 90, 'location'), lng = num(body.lng, -180, 180, 'location');
  const f = venueFields(body);
  await moderate(ctx, 'place', f.name, f.description);
  const near = await db.prepare('SELECT name FROM venues WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').bind(lat - 0.0003, lat + 0.0003, lng - 0.0004, lng + 0.0004).first();
  if (near) fail(409, `${near.name} is already on Pinnit. Add prices or hours to it instead`);
  await placeOrFail(db, lat, lng, 'venue');
  const id = uuid();
  await write(db, [db.prepare('INSERT INTO venues (id, name, kind, lat, lng, address, description, website, access, created_by, manager_id, manager_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .bind(id, f.name, f.kind, lat, lng, str(body.address, 120, { name: 'address' }), f.description, f.website, f.access, me, body.manager_id ? me : null, now())]);
  return { id };
});
route('PATCH', '/api/venues/:id', async ctx => {
  const { db, me, params, body } = ctx;
  const v = await getVenue(db, params.id);
  if (v.created_by !== me && v.manager_id !== me) fail(403, 'Only the person who added this venue or its manager can edit it');
  const f = venueFields({ ...v, access: parseJ(v.access), ...body });
  await moderate(ctx, 'place', f.name, f.description);
  await write(db, [db.prepare('UPDATE venues SET name = ?, kind = ?, access = ?, description = ?, website = ? WHERE id = ?').bind(f.name, f.kind, f.access, f.description, f.website, v.id)]);
  return { ok: true };
});
route('POST', '/api/venues/:id/claim', async ({ db, me, params }) => {
  const v = await getVenue(db, params.id);
  if (v.manager_id) fail(409, 'This venue already has a manager');
  await write(db, [db.prepare('UPDATE venues SET manager_id = ?, manager_verified = 0 WHERE id = ? AND manager_id IS NULL').bind(me, v.id)]);
  return { ok: true };
});
route('POST', '/api/venues/:id/confirm-prices', async ({ db, params }) => {
  await write(db, [db.prepare('UPDATE venues SET prices_checked_at = ? WHERE id = ?').bind(now(), params.id)]);
  return { ok: true };
});
route('POST', '/api/prices', async ctx => {
  const { db, me, body } = ctx;
  const label = str(body.label, 60, { required: true, name: 'label' }), price = num(body.price, 0, 99999, 'price'), unit = oneOf(body.unit, UNITS, 'unit', 'entry'), note = str(body.note, 100, { name: 'note' });
  await moderate(ctx, 'price', label, note);
  if (body.id) {
    const p = await db.prepare('SELECT id FROM venue_prices WHERE id = ?').bind(String(body.id)).first() || fail(404, 'That price was removed');
    await write(db, [db.prepare('UPDATE venue_prices SET label = ?, price = ?, unit = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(label, price, unit, note, me, now(), p.id)]);
  } else {
    const v = await getVenue(db, String(body.venue_id));
    await write(db, [db.prepare('INSERT INTO venue_prices (id, venue_id, label, price, unit, note, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), v.id, label, price, unit, note, me, me, now())]);
  }
  return { ok: true };
});
route('DELETE', '/api/prices/:id', async ({ db, me, params }) => {
  const p = await db.prepare('SELECT p.created_by, v.manager_id FROM venue_prices p JOIN venues v ON v.id = p.venue_id WHERE p.id = ?').bind(params.id).first() || fail(404, 'That price was removed');
  if (p.created_by !== me && p.manager_id !== me) fail(403, 'Only the person who added this price or the venue manager can remove it');
  await write(db, [db.prepare('DELETE FROM venue_prices WHERE id = ?').bind(params.id)]);
  return { ok: true };
});
route('POST', '/api/slots', async ctx => {
  const { db, me, body } = ctx;
  await moderate(ctx, 'hours', body.note);
  const v = await getVenue(db, String(body.venue_id));
  if (v.manager_id !== me) fail(403, 'Only the venue manager can post hours');
  const days = listOf(body.days, [0, 1, 2, 3, 4, 5, 6]);
  const t = x => /^\d{2}:\d{2}$/.test(x) ? x : fail(400, 'Check the times');
  const a = t(body.start_time), b = t(body.end_time);
  if (!days.length) fail(400, 'Pick at least one day');
  if (b <= a) fail(400, 'The end time needs to be after the start time');
  await write(db, [db.prepare('INSERT INTO venue_slots (id, venue_id, days, start_time, end_time, note, posted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), v.id, JSON.stringify(days.sort()), a, b, str(body.note, 120, { name: 'note' }), me, now())]);
  return { ok: true };
});
route('DELETE', '/api/slots/:id', async ({ db, me, params }) => {
  const s = await db.prepare('SELECT v.manager_id FROM venue_slots s JOIN venues v ON v.id = s.venue_id WHERE s.id = ?').bind(params.id).first() || fail(404, 'Already removed');
  if (s.manager_id !== me) fail(403, 'Only the venue manager can remove hours');
  await write(db, [db.prepare('DELETE FROM venue_slots WHERE id = ?').bind(params.id)]);
  return { ok: true };
});
route('POST', '/api/reviews', async ctx => {
  const { db, me, body } = ctx;
  await moderate(ctx, 'review', body.body);
  const v = await getVenue(db, String(body.venue_id));
  const rating = Math.round(num(body.rating, 1, 5, 'rating'));
  const photo = body.photo == null ? null : /^\/api\/photo\/[\w-]+$/.test(body.photo) ? body.photo : fail(400, 'Bad photo');
  await write(db, [
    db.prepare('DELETE FROM reviews WHERE venue_id = ? AND user_id = ?').bind(v.id, me),
    db.prepare('INSERT INTO reviews (id, venue_id, user_id, rating, body, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uuid(), v.id, me, rating, str(body.body, 400, { name: 'review' }), photo, now())
  ]);
  return { ok: true };
});
route('DELETE', '/api/reviews/:id', async ({ db, me, params }) => {
  await write(db, [db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').bind(params.id, me)]);
  return { ok: true };
});

// safety: private check-ins, reports, blocks
route('GET', '/api/safety', async ({ db, me }) => (await db.prepare('SELECT event_id, feel, created_at FROM safety WHERE user_id = ?').bind(me).all()).results);
route('POST', '/api/safety', async ({ db, me, body }) => {
  await db.prepare('INSERT OR REPLACE INTO safety (user_id, event_id, feel, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(me, String(body.event_id), body.feel == null ? null : oneOf(body.feel, FEELS, 'answer'), str(body.note, 500, { name: 'note' }), now()).run();
  return { ok: true };
});
route('POST', '/api/reports', async ({ db, me, body }) => {
  if (await countSince(db, 'SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?', me, new Date(Date.now() - D).toISOString()) >= 30) fail(429, 'Thanks. We have your reports');
  await db.prepare('INSERT INTO reports (id, reporter_id, kind, target_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(uuid(), me, oneOf(body.kind, REPORT_KINDS, 'report type'), str(body.target_id, 64, { required: true, name: 'target' }), str(body.reason, 80, { required: true, name: 'reason' }), str(body.details, 500, { name: 'detail' }), now()).run();
  return { ok: true };
});
route('GET', '/api/blocks', async ({ db, me }) => (await db.prepare(`SELECT ${PUBLIC} FROM profiles WHERE id IN (SELECT blocked_id FROM blocks WHERE user_id = ?)`).bind(me).all()).results.map(profileOut));
route('POST', '/api/blocks/:id', async ({ db, me, params }) => {
  const other = params.id; if (other === me) fail(400, "You can't block yourself");
  const [a, b] = pair(me, other);
  await write(db, [
    db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)').bind(me, other),
    db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b),
    // leave their events, and remove them from yours
    db.prepare('DELETE FROM participants WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE host_id = ?)').bind(me, other),
    db.prepare('DELETE FROM participants WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE host_id = ?)').bind(other, me)
  ]);
  return { ok: true };
});
route('DELETE', '/api/blocks/:id', async ({ db, me, params }) => {
  await db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').bind(me, params.id).run();
  return { ok: true };
});

// badges + streaks
route('GET', '/api/history', async ({ db, me }) => (await db.prepare(`
  SELECT e.id, e.title, e.category, e.activity, e.starts_at, e.duration_mins, e.host_id = ? AS hosted, pa.arrived_at IS NOT NULL AS arrived,
    (SELECT json_group_array(json_object('user_id', p.id, 'display_name', p.display_name, 'avatar_url', p.avatar_url)) FROM participants o JOIN profiles p ON p.id = o.user_id WHERE o.event_id = e.id AND o.user_id != pa.user_id) AS people
  FROM participants pa JOIN events e ON e.id = pa.event_id WHERE pa.user_id = ?`).bind(me, me).all()).results.map(h => ({ ...h, hosted: !!h.hosted, arrived: !!h.arrived, people: parseJ(h.people) || [] })));
route('GET', '/api/progress', async ({ db, me }) => {
  const [rv, bd, pl] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?').bind(me),
    db.prepare('SELECT badge_id FROM badges WHERE user_id = ?').bind(me),
    db.prepare('SELECT (SELECT COUNT(*) FROM venues WHERE created_by = ?) + (SELECT COUNT(*) FROM venue_prices WHERE created_by = ? OR updated_by = ?) AS n').bind(me, me, me)
  ]);
  return { reviews: rv.results[0].n, badges: bd.results.map(b => b.badge_id), places: pl.results[0].n };
});
route('POST', '/api/badges', async ({ db, me, body }) => {
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => /^[a-z]{2,16}$/.test(x)).slice(0, 20) : [];
  if (ids.length) await db.batch(ids.map(id => db.prepare('INSERT OR IGNORE INTO badges (user_id, badge_id) VALUES (?, ?)').bind(me, id)));
  return { ok: true };
});

// polling: what changed since the phone last looked
route('GET', '/api/pulse', async ({ db, me, url }) => {
  const since = url.searchParams.get('since') || now();
  const [v, joins, fr] = await db.batch([
    db.prepare("SELECT value FROM meta WHERE key = 'version'"),
    db.prepare('SELECT pa.event_id, pa.user_id, NOT EXISTS (SELECT 1 FROM participants x WHERE x.user_id = pa.user_id AND x.joined_at < pa.joined_at) AS first_timer FROM participants pa JOIN events e ON e.id = pa.event_id WHERE e.host_id = ? AND pa.user_id != ? AND pa.joined_at > ?').bind(me, me, since),
    db.prepare('SELECT * FROM friendships WHERE (user_a = ? OR user_b = ?) AND updated_at > ?').bind(me, me, since)
  ]);
  return { version: Number(v.results[0]?.value || 0), at: now(), joins: joins.results, friendships: fr.results };
});

/* ---------- entry point ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (!env.DB) fail(503, 'The Pinnit database is not connected yet');
      const db = env.DB;
      await ensureReady(db);
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) fail(404, 'Not found');
      const params = r.re.exec(url.pathname).groups || {};
      let me = null, token = null;
      if (!r.public) {
        token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (token.length === 64) me = (await db.prepare('SELECT id FROM profiles WHERE token_hash = ?').bind(await sha256(token)).first())?.id || null;
        if (!me) fail(401, 'Please set up Pinnit again');
      }
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (Number(req.headers.get('Content-Length') || 0) > 1.2e6) fail(413, 'That is too big to upload');
        try { body = await req.json(); } catch { body = {}; }
        if (!body || typeof body !== 'object') body = {};
      }
      const out = await r.handler({ db, me, params, body, url, req, env });
      if (r.raw) return out;
      const res = json(out);
      // Keep a server-set backup of the phone's key. Safari clears browser storage after 7 days without
      // a visit, but not cookies the server sets, so /api/session can quietly restore the account.
      const path = url.pathname;
      const keep = path === '/api/account' || path === '/api/session' || path === '/api/recover' ? out && out.token
        : path === '/api/me' && req.method === 'DELETE' ? '' : token;
      if (keep != null) res.headers.append('Set-Cookie', `pinnit_key=${keep}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${keep ? 34560000 : 0}`);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Try again in a moment' }, 500);
    }
  }
};
