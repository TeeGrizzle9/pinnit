// Pinnit rewards: points, levels and referral progress.
//
// Points are never added up as people tap things. They are worked out from what actually happened
// (verified check-ins, invites, cancellations, safety checks), so they can be re-checked at any time
// and can't be farmed from the phone. Example events never count.
//
//   Attend a game ................. 10   checked in on the spot, and 2+ people checked in
//   Host a game that fills ........ 20   all spots taken (4+ spots), 3+ people checked in
//   Play together ................. 15   you and the new player you brought both check in at their first game (both get it, once per new player)
//   Cancel 24+ hours ahead ........  5   at most once a week
//   Complete a safety check .......  5   only for games you checked in to, at most 3 a week
//   Weekly cap .................... 100  across everything
// Not rewarded: logins, opening the app, posting games that don't fill, ratings.

export const POINTS = { attend: 10, host_fill: 20, play_together: 15, cancel_early: 5, safety: 5 };
export const CANCEL_HOURS = 24;
const WEEK_CAP = 100, CAPS = { cancel_early: 5, safety: 15 };   // per week
export const LEVELS = [{ id: 'rookie', label: 'Rookie', min: 0 }, { id: 'regular', label: 'Regular', min: 100 }, { id: 'legend', label: 'Local Legend', min: 300 }];
export const levelFor = pts => [...LEVELS].reverse().find(l => pts >= l.min);

// weeks run Monday to Sunday, Sydney time (UTC+10 is close enough for bucketing)
const weekOf = iso => { const d = new Date(Date.parse(iso) + 10 * 3600e3); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

export async function computeRewards(db, me) {
  const nowIso = new Date().toISOString();
  const [mine, cancels, safety, invites] = await db.batch([
    // every game I joined, with how many joined and how many checked in
    db.prepare(`SELECT e.id, e.title, e.activity, e.starts_at, e.host_id, e.max_people, e.filled_at, pa.arrived_at,
        (SELECT COUNT(*) FROM participants x WHERE x.event_id = e.id) AS joined,
        (SELECT COUNT(*) FROM participants x WHERE x.event_id = e.id AND x.arrived_at IS NOT NULL) AS checked
      FROM participants pa JOIN events e ON e.id = pa.event_id WHERE pa.user_id = ? AND e.is_sample = 0`).bind(me),
    db.prepare('SELECT c.event_id, c.at, e.title, e.activity FROM cancellations c LEFT JOIN events e ON e.id = c.event_id WHERE c.user_id = ?').bind(me),
    db.prepare(`SELECT s.event_id, s.created_at, e.title, e.activity FROM safety s JOIN participants p ON p.event_id = s.event_id AND p.user_id = s.user_id JOIN events e ON e.id = s.event_id
      WHERE s.user_id = ? AND s.feel IS NOT NULL AND p.arrived_at IS NOT NULL AND e.is_sample = 0`).bind(me),
    db.prepare('SELECT inviter_id, invitee_id FROM invites WHERE inviter_id = ? OR invitee_id = ?').bind(me, me)
  ]);
  const items = [];
  const name = r => r.title || r.activity || 'a game';
  for (const r of mine.results) {
    if (r.arrived_at && r.checked >= 2) items.push({ kind: 'attend', at: r.starts_at, label: `Attended ${name(r)}` });
    if (r.host_id === me && r.starts_at <= nowIso && r.max_people >= 4 && (r.filled_at || r.joined >= r.max_people) && r.checked >= 3) items.push({ kind: 'host_fill', at: r.starts_at, label: `Hosted ${name(r)} and it filled` });
  }
  for (const c of cancels.results) items.push({ kind: 'cancel_early', at: c.at, label: `Cancelled ${name(c)} early` });
  for (const s of safety.results) items.push({ kind: 'safety', at: s.created_at, label: `Safety check for ${name(s)}` });
  // play together: the new player's first checked-in game, with the person who brought them also there
  for (const inv of invites.results.slice(0, 60)) {
    const g = await db.prepare(`SELECT e.starts_at, e.title, e.activity FROM participants a JOIN participants b ON b.event_id = a.event_id JOIN events e ON e.id = a.event_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.arrived_at IS NOT NULL AND b.arrived_at IS NOT NULL AND e.is_sample = 0
        AND NOT EXISTS (SELECT 1 FROM participants c JOIN events ce ON ce.id = c.event_id WHERE c.user_id = a.user_id AND c.arrived_at IS NOT NULL AND ce.is_sample = 0 AND c.arrived_at < a.arrived_at)
      LIMIT 1`).bind(inv.invitee_id, inv.inviter_id).first();
    if (g) items.push({ kind: 'play_together', at: g.starts_at, label: inv.inviter_id === me ? `Played ${name(g)} with a new player you brought` : `Played ${name(g)} with the friend who invited you` });
  }
  // apply the caps week by week
  items.sort((a, b) => a.at.localeCompare(b.at));
  const weeks = {};
  for (const it of items) {
    const w = weeks[it.at && weekOf(it.at)] ||= { total: 0, kinds: {} };
    let pts = POINTS[it.kind];
    if (CAPS[it.kind] != null) pts = Math.max(0, Math.min(pts, CAPS[it.kind] - (w.kinds[it.kind] || 0)));
    pts = Math.max(0, Math.min(pts, WEEK_CAP - w.total));
    w.kinds[it.kind] = (w.kinds[it.kind] || 0) + pts; w.total += pts;
    it.points = pts; if (!pts) it.capped = true;
  }
  const points = items.reduce((s, it) => s + it.points, 0);
  const thisWeek = (weeks[weekOf(nowIso)] || { total: 0 }).total;
  return { points, thisWeek, weekCap: WEEK_CAP, items: items.slice().reverse().slice(0, 30), referral: await referralStats(db, me) };
}

// referral badges: Bring a mate (1 friend attends), Crew builder (3), Community seed (5 across 2+ games),
// Squad (a full game where 3+ players came via your invites)
async function referralStats(db, me) {
  const [att, squad, brought] = await db.batch([
    db.prepare(`SELECT COUNT(DISTINCT p.user_id) AS friends, COUNT(DISTINCT p.event_id) AS games FROM participants p JOIN events e ON e.id = p.event_id JOIN invites i ON i.invitee_id = p.user_id
      WHERE i.inviter_id = ? AND p.arrived_at IS NOT NULL AND e.is_sample = 0`).bind(me),
    db.prepare(`SELECT e.id FROM events e WHERE e.is_sample = 0 AND (e.filled_at IS NOT NULL OR (SELECT COUNT(*) FROM participants x WHERE x.event_id = e.id) >= e.max_people)
      AND (SELECT COUNT(*) FROM participants x JOIN invites i ON i.invitee_id = x.user_id WHERE x.event_id = e.id AND i.inviter_id = ?) >= 3 LIMIT 1`).bind(me),
    db.prepare('SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ?').bind(me)
  ]);
  const a = att.results[0] || {};
  return { invited: brought.results[0].n, friendsAttended: a.friends || 0, friendGames: a.games || 0, squad: !!squad.results.length };
}

// keep the cached points on profiles fresh, so levels show next to names without recalculating
export async function recalc(db, ids) {
  for (const id of [...new Set(ids.filter(Boolean))].slice(0, 40)) {
    try { const r = await computeRewards(db, id); await db.prepare('UPDATE profiles SET points = ? WHERE id = ?').bind(r.points, id).run(); }
    catch (e) { console.warn('recalc failed', id, e && e.message); }
  }
}
