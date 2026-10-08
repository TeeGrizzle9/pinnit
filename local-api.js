/* =====================================================================
   Pinnit local backend: a stand-in for Supabase that lives on the phone.
   Anyone who scans the QR code gets their own copy, seeded with a small
   Sydney community, and everything they do (profile, pins, joins, chat,
   reviews, badges) is saved in this browser's localStorage.
   Nothing is shared between phones, so other people's pins never change.
   People, prices and hours are made up; every pin is a real public place
   whose coordinates pass the same public-space check as real pins.
   ===================================================================== */
(function () {
  const KEY = 'pinnit_local_v1';
  const ME = 'me', H = 3600e3, D = 864e5;
  const uid = () => 'l' + Math.random().toString(36).slice(2, 10);
  const iso = ms => new Date(ms).toISOString();
  const clone = x => JSON.parse(JSON.stringify(x));
  const later = v => new Promise(r => setTimeout(() => r(v === undefined ? undefined : clone(v)), 80));
  const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const code = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

  /* ---------- seed: a small, believable community ---------- */
  function seed() {
    const NOW = Date.now();
    const at = (hoursFromNow, roundTo = 15) => { const d = new Date(NOW + hoursFromNow * H); d.setMinutes(Math.round(d.getMinutes() / roundTo) * roundTo, 0, 0); return +d; };
    const profiles = {
      p1: { id: 'p1', display_name: 'Priya', age_bracket: '25-35', gender: 'woman', bio: 'Knitter, chess fiend, oat flat white.', referral_code: 'PRIYA1' },
      p2: { id: 'p2', display_name: 'Tom', age_bracket: '18-25', gender: 'man', bio: 'Weekend hoops and Sunday swims.', referral_code: 'TOMMY2' },
      p3: { id: 'p3', display_name: 'Mei', age_bracket: '45-55', gender: 'woman', bio: 'Tai chi most mornings.', referral_code: 'MEI333' },
      p4: { id: 'p4', display_name: 'Sam', age_bracket: '18-25', gender: 'non_binary', bio: 'Uni student, ukulele, board games.', referral_code: 'SAMSAM' },
      p5: { id: 'p5', display_name: 'Jordan', age_bracket: '25-35', gender: 'man', bio: '', referral_code: 'JORD55' },
      p6: { id: 'p6', display_name: 'Aisha', age_bracket: '35-45', gender: 'woman', bio: 'Runs the Saturday beach clean-up.', referral_code: 'AISHA6' },
      p7: { id: 'p7', display_name: 'Luca', age_bracket: '65-75', gender: 'man', bio: 'Retired teacher. Chess and birdwatching.', referral_code: 'LUCA77' }
    };
    Object.values(profiles).forEach(p => Object.assign(p, { avatar_url: null, created_at: iso(NOW - 60 * D) }));

    const today = new Date(NOW).getDay();
    const venues = [
      { id: 'v1', name: 'Victoria Park Pool', kind: 'pool', lat: -33.88609, lng: 151.192216, address: 'Camperdown', access: ['wheelchair', 'step_free', 'toilet', 'transport'], description: 'Outdoor 50m pool beside Lake Northam. (Sample details.)', website: '', created_by: 'p2', manager_id: null, manager_verified: false, prices_checked_at: iso(NOW - 3 * D) },
      { id: 'v2', name: 'Ian Thorpe Aquatic Centre', kind: 'pool', lat: -33.877347, lng: 151.198862, address: 'Ultimo', access: ['wheelchair', 'step_free', 'toilet', 'seating', 'transport'], description: 'Indoor pools and gym. (Sample details.)', website: '', created_by: 'p1', manager_id: null, manager_verified: false, prices_checked_at: null },
      { id: 'v3', name: 'Prince Alfred Park basketball court', kind: 'court', lat: -33.887357, lng: 151.204734, address: 'Surry Hills', access: ['step_free', 'transport'], description: 'Outdoor court in Prince Alfred Park. (Sample hours.)', website: '', created_by: 'p5', manager_id: 'p5', manager_verified: true, prices_checked_at: null },
      { id: 'v4', name: 'Glebe Town Hall', kind: 'hall', lat: -33.882576, lng: 151.185091, address: 'Glebe', access: ['wheelchair', 'step_free', 'toilet', 'seating', 'transport'], description: 'Community hall with tables and chairs. (Sample hours and prices.)', website: '', created_by: 'p3', manager_id: 'p3', manager_verified: false, prices_checked_at: iso(NOW - 20 * D) },
      { id: 'v5', name: 'Prince Alfred Park tennis courts', kind: 'court', lat: -33.887726, lng: 151.204228, address: 'Surry Hills', access: ['wheelchair', 'shade'], description: 'Public tennis courts. (Sample details.)', website: '', created_by: 'p5', manager_id: null, manager_verified: false, prices_checked_at: null }
    ].map(v => ({ ...v, created_at: iso(NOW - 30 * D) }));
    const prices = [
      ['v1', 'Adult entry', 8.20, 'entry', '', 'p2', 3], ['v1', 'Child entry', 5.80, 'entry', 'Ages 3 to 15', 'p2', 3], ['v1', 'Concession', 5.80, 'entry', '', 'p1', 9],
      ['v1', 'Adult 10-visit pass', 73.80, 'pass', '', 'p2', 3], ['v1', 'Lane hire', 45, 'hour', 'Book at front desk', 'p6', 40],
      ['v2', 'Adult entry', 9.10, 'entry', '', 'p1', 12], ['v2', 'Concession', 6.40, 'entry', '', 'p1', 12],
      ['v4', 'Room hire', 35, 'hour', 'Community groups rate', 'p3', 20]
    ].map(([venue_id, label, price, unit, note, by, daysAgo], i) => ({ id: 'pr' + i, venue_id, label, price, unit, note: note || null, created_by: by, updated_by: by, updated_at: iso(NOW - daysAgo * D) }));
    const openStart = at(-1, 30), openEnd = at(3, 30);
    const slots = [
      { venue_id: 'v3', days: [1, 2, 3, 4, 5], start_time: '16:00', end_time: '20:00', note: 'Bring your own ball.' },
      { venue_id: 'v3', days: [0, 6], start_time: '08:00', end_time: '17:00', note: null },
      { venue_id: 'v4', days: [2, 4], start_time: '10:00', end_time: '14:00', note: 'Main hall, free for community groups' },
      { venue_id: 'v4', days: [today], start_time: hhmm(openStart), end_time: hhmm(openEnd), note: 'Side room free today' }
    ].map((s, i) => ({ id: 'sl' + i, ...s }));
    const reviews = [
      ['v1', 'p2', 5, 'Best outdoor pool in the inner west. Slow lane is genuinely slow, which I love.', 6],
      ['v1', 'p6', 4, 'Gets busy after 5 in summer. Change rooms are clean and step-free.', 21],
      ['v3', 'p5', 4, 'Good rims, lights on until 8. Floor is a bit slippery after rain.', 3],
      ['v4', 'p1', 5, 'Lovely warm hall for board games. Plenty of tables and an accessible loo.', 10],
      ['v4', 'p7', 4, 'Quiet and easy to get to from the bus. Bring your own tea.', 30]
    ].map(([venue_id, user_id, rating, body, daysAgo], i) => ({ id: 'rv' + i, venue_id, user_id, rating, body, photo: null, created_at: iso(NOW - daysAgo * D) }));

    const events = [];
    const ev = o => {
      const { starts, people, ...rest } = o;
      events.push({
        id: 'e' + events.length, cost: null, skill: 'All levels', gender_rule: 'everyone', age_brackets: null, notes: null, meeting_point: null,
        access: [], noise_level: null, venue_id: null, title: null, category: null, created_at: iso(NOW - D), ...rest,
        starts_at: iso(starts),
        participants: [rest.host_id, ...people].map((u, i) => ({ user_id: u, joined_at: iso(NOW - (12 - i) * H), arrived_at: null }))
      });
    };
    ev({ host_id: 'p1', activity: 'knitting', category: 'arts', title: 'Stitch and chat under the fig tree', starts: at(-0.4), duration_mins: 120, max_people: 12, lat: -33.885935, lng: 151.193935, place: 'Victoria Park, Camperdown', noise_level: 'quiet', access: ['wheelchair', 'seating', 'shade', 'newcomers', 'sensory'], meeting_point: 'On the lawn near Lake Northam', notes: 'Spare needles and wool to share. Total beginners very welcome.', people: ['p3', 'p7'] });
    ev({ host_id: 'p7', activity: 'chess', category: 'games', title: 'Chess in the park', starts: at(1), duration_mins: 180, max_people: 10, lat: -33.8716, lng: 151.2116, place: 'Hyde Park, Sydney', noise_level: 'quiet', access: ['wheelchair', 'seating', 'transport', 'gear', 'newcomers'], meeting_point: 'Giant chessboard near the Archibald Fountain', people: ['p4'] });
    ev({ host_id: 'p6', activity: 'dance', category: 'move', title: 'Outdoor hour of dance', starts: at(2.5), duration_mins: 60, max_people: 30, lat: -33.8682, lng: 151.2142, place: 'The Domain, Sydney', noise_level: 'loud', access: ['step_free', 'transport', 'newcomers', 'kids'], meeting_point: 'Near the big Moreton Bay fig', notes: 'Bluetooth speaker, easy follow-along moves. No experience needed.', people: ['p1', 'p4', 'p5'] });
    ev({ host_id: 'p2', activity: 'basketball', category: 'sport', title: 'After-work pickup hoops', starts: at(4), duration_mins: 90, max_people: 10, lat: -33.887357, lng: 151.204734, place: 'Prince Alfred Park basketball court, Surry Hills', venue_id: 'v3', noise_level: 'moderate', skill: 'Intermediate', access: ['step_free'], meeting_point: 'Courtside, I will have a red ball', people: ['p5'] });
    ev({ host_id: 'p3', activity: 'taichi', category: 'move', title: 'Gentle morning tai chi', starts: at(19), duration_mins: 60, max_people: 20, lat: -33.8975, lng: 151.2340, place: 'Centennial Park, Centennial Park', noise_level: 'quiet', access: ['wheelchair', 'step_free', 'shade', 'newcomers'], age_brackets: ['45-55', '55-65', '65-75', '75+'], people: ['p7'] });
    ev({ host_id: 'p6', activity: 'cleanup', category: 'outdoors', title: 'Saturday beach clean-up', starts: at(26), duration_mins: 120, max_people: 40, lat: -33.8915, lng: 151.2767, place: 'Bondi Beach, Bondi Beach', noise_level: 'moderate', access: ['toilet', 'transport', 'kids', 'dogs', 'gear'], meeting_point: 'Outside the Pavilion', notes: 'Gloves and bags provided. Coffee after for anyone keen.', people: ['p2', 'p1'] });
    ev({ host_id: 'p4', activity: 'jam', category: 'music', title: 'Acoustic jam, bring an instrument', starts: at(6), duration_mins: 120, max_people: 15, lat: -33.894161, lng: 151.179368, place: 'Camperdown Memorial Rest Park, Newtown', noise_level: 'loud', access: ['shade', 'alcohol_free'], people: ['p5'] });
    ev({ host_id: 'p3', activity: 'support', category: 'wellbeing', title: 'Walk and talk for new parents', starts: at(22), duration_mins: 60, max_people: 12, lat: -33.88781, lng: 151.20502, place: 'Prince Alfred Park, Surry Hills', noise_level: 'quiet', access: ['wheelchair', 'step_free', 'kids', 'sensory'], gender_rule: 'women_nb', people: ['p1'] });
    ev({ host_id: 'p1', activity: 'boardgames', category: 'games', title: 'Board games and tea', starts: at(30), duration_mins: 180, max_people: 16, lat: -33.882576, lng: 151.185091, place: 'Glebe Town Hall, Glebe', venue_id: 'v4', noise_level: 'moderate', access: ['wheelchair', 'toilet', 'seating', 'gear', 'alcohol_free'], people: ['p4', 'p7'] });
    ev({ host_id: 'p2', activity: 'swimming', category: 'move', title: 'Slow lane social swim', starts: at(16), duration_mins: 60, max_people: 8, lat: -33.88609, lng: 151.192216, place: 'Victoria Park Pool, Camperdown', venue_id: 'v1', noise_level: 'moderate', access: ['wheelchair', 'toilet', 'newcomers'], notes: 'Pay your own entry at the desk. All speeds welcome.', people: [] });
    ev({ host_id: 'p5', activity: 'other', category: 'arts', title: 'Zine-making afternoon', starts: at(50), duration_mins: 180, max_people: 12, lat: -33.864369, lng: 151.191454, place: 'Pirrama Park, Pyrmont', noise_level: 'quiet', access: ['seating', 'shade', 'gear'], people: [] });
    ev({ host_id: 'p7', activity: 'birdwatching', category: 'outdoors', title: 'Dawn birdwatching', starts: at(40), duration_mins: 90, max_people: 8, lat: -33.872212, lng: 151.178507, place: 'Bicentennial Park, Glebe', noise_level: 'quiet', access: ['step_free'], people: ['p3'] });

    const messages = [
      { id: 'm0', event_id: 'e3', user_id: 'p2', body: 'Courts are free from 4. I will bring two balls.', created_at: iso(NOW - 2 * H) },
      { id: 'm1', event_id: 'e3', user_id: 'p5', body: 'Legend, see you there', created_at: iso(NOW - 1.5 * H) }
    ];
    return {
      savedAt: NOW, profiles, venues, prices, slots, reviews, events, messages,
      checkins: [], friendships: [], reports: [], blocks: [], safety: [], badges: []
    };
  }

  /* ---------- load + save ---------- */
  function load() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch {}
    if (!db || !db.events) return seed();
    // keep the sample community feeling current: slide other people's events forward by the time
    // that's passed, but leave anything you've joined or hosted on its real schedule
    const shift = Date.now() - (db.savedAt || Date.now());
    if (shift > 60e3) db.events.forEach(e => {
      if (e.host_id === ME || e.participants.some(p => p.user_id === ME)) return;
      e.starts_at = iso(+new Date(e.starts_at) + shift);
    });
    return db;
  }
  let db = load();
  function save() {
    db.savedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
    catch (e) { console.warn('Could not save Pinnit data', e); return false; }
  }
  save();

  const P = id => db.profiles[id] ? { ...db.profiles[id] } : null;
  const blocked = id => db.blocks.includes(id);
  const venue = id => { const v = db.venues.find(x => x.id === id); if (!v) throw new Error('That venue was removed'); return v; };
  const pair = (x, y) => x < y ? [x, y] : [y, x];
  const hasAccount = () => !!db.profiles[ME];
  let session = hasAccount() ? { user: { id: ME, email: '', user_metadata: {} } } : null;
  const authCbs = [], globalCbs = [], eventCbs = {};
  const fire = (table, eventType, row) => globalCbs.forEach(cb => setTimeout(() => cb(table, { eventType, new: row || {} }), 0));
  const emitMsg = m => (eventCbs[m.event_id] || []).forEach(cb => setTimeout(() => cb('message', { new: m }), 30));
  const blobToDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

  // a friendly host says hello in the group chat when you join
  function hostHello(e) {
    if (e.host_id === ME) return;
    const me = db.profiles[ME], host = db.profiles[e.host_id]; if (!me || !host) return;
    const newbie = !db.events.some(x => x.id !== e.id && x.participants.some(p => p.user_id === ME));
    setTimeout(() => {
      const ev = db.events.find(x => x.id === e.id);
      if (!ev || !ev.participants.some(p => p.user_id === ME)) return;
      const where = ev.meeting_point ? ` Look for us: ${ev.meeting_point.charAt(0).toLowerCase() + ev.meeting_point.slice(1)}.` : '';
      const m = { id: uid(), event_id: e.id, user_id: e.host_id, body: newbie ? `Welcome ${me.display_name}! Great to have a first-timer, I'll keep an eye out for you.${where}` : `Hey ${me.display_name}, glad you're coming!${where}`, created_at: iso(Date.now()) };
      db.messages.push(m); save(); emitMsg(m);
    }, 3500);
  }

  window.PINNIT_LOCAL = true;
  window.PINNIT_API_FACTORY = () => ({
    local: true,
    async getSession() { return session; },
    onAuth(cb) { authCbs.push(cb); },
    async createAccount(profile) {
      db.profiles[ME] = { id: ME, bio: '', avatar_url: null, gender: 'prefer_not', referral_code: code(), created_at: iso(Date.now()), ...profile };
      // a couple of locals have already said hi, so the friends features have something in them
      if (!db.friendships.length) db.friendships.push({ user_a: ME, user_b: 'p1', status: 'pending', requested_by: 'p1' });
      save();
      session = { user: { id: ME, email: '', user_metadata: {} } };
      authCbs.forEach(cb => setTimeout(() => cb('SIGNED_IN', session), 0));
      return session;
    },
    async signUp() { throw new Error('Use the Get started screen'); },
    async signIn() { throw new Error('Use the Get started screen'); },
    async signOut() {
      try { localStorage.removeItem(KEY); } catch {}
      db = seed(); session = null; save();
      authCbs.forEach(cb => setTimeout(() => cb('SIGNED_OUT', null), 0));
    },
    async resetPassword() {},
    async updatePassword() {},
    async myProfile() { return later(P(ME)); },
    async updateProfile(id, patch) { Object.assign(db.profiles[id], patch); save(); return later(P(id)); },
    async uploadAvatar(id, blob) { return blobToDataUrl(blob); },
    async profile(id) { return later(P(id)); },

    async listEvents() {
      return later(db.events.filter(e => +new Date(e.starts_at) > Date.now() - 8 * H && !blocked(e.host_id)).map(e => ({
        ...e, host: P(e.host_id), participants: e.participants.map(p => ({ ...p, profile: P(p.user_id) }))
      })));
    },
    async createEvent(row) {
      const e = { ...row, id: uid(), host_id: ME, created_at: iso(Date.now()), participants: [{ user_id: ME, joined_at: iso(Date.now()), arrived_at: null }] };
      db.events.push(e); save(); fire('events', 'INSERT', e);
      // someone nearby is keen: a local joins your event shortly after you post it
      setTimeout(() => {
        const ev = db.events.find(x => x.id === e.id); if (!ev || ev.participants.length >= ev.max_people) return;
        const pick = ['p4', 'p1', 'p6', 'p5'].find(id => !ev.participants.some(p => p.user_id === id) && !blocked(id));
        if (!pick) return;
        ev.participants.push({ user_id: pick, joined_at: iso(Date.now()), arrived_at: null }); save();
        fire('participants', 'INSERT', { event_id: e.id, user_id: pick });
      }, 9000);
      return later({ id: e.id });
    },
    async deleteEvent(id) { db.events = db.events.filter(e => e.id !== id); save(); fire('events', 'DELETE'); },
    async join(id) {
      const e = db.events.find(x => x.id === id);
      if (e && !e.participants.some(p => p.user_id === ME)) { e.participants.push({ user_id: ME, joined_at: iso(Date.now()), arrived_at: null }); save(); hostHello(e); }
    },
    async leave(id) { const e = db.events.find(x => x.id === id); if (e) { e.participants = e.participants.filter(p => p.user_id !== ME); save(); } },
    async markArrived(id) { const e = db.events.find(x => x.id === id), p = e && e.participants.find(x => x.user_id === ME); if (p) { p.arrived_at = iso(Date.now()); save(); } },
    async messages(id) { return later(db.messages.filter(m => m.event_id === id && !blocked(m.user_id))); },
    async sendMessage(id, body) {
      const m = { id: uid(), event_id: id, user_id: ME, body, created_at: iso(Date.now()) };
      db.messages.push(m); save(); emitMsg(m);
    },
    async checkins(id) { return later(db.checkins.filter(c => c.event_id === id)); },
    async checkin(id, u, lat, lng) {
      const c = db.checkins.find(x => x.event_id === id && x.user_id === u);
      if (c) Object.assign(c, { lat, lng, updated_at: iso(Date.now()) }); else db.checkins.push({ event_id: id, user_id: u, lat, lng, updated_at: iso(Date.now()) });
      save();
    },
    async stopCheckin(id, u) { db.checkins = db.checkins.filter(x => !(x.event_id === id && x.user_id === u)); save(); },

    async friendships() { return later(db.friendships.filter(f => !blocked(f.user_a === ME ? f.user_b : f.user_a)).map(f => ({ ...f, a: P(f.user_a), b: P(f.user_b) }))); },
    async requestFriend(other) {
      const [a, b] = pair(ME, other), f = db.friendships.find(x => x.user_a === a && x.user_b === b);
      if (f) {
        if (f.status === 'pending' && f.requested_by !== ME) { f.status = 'accepted'; save(); return 'accepted'; }
        return f.status === 'accepted' ? 'friends' : 'pending';
      }
      db.friendships.push({ user_a: a, user_b: b, status: 'pending', requested_by: ME }); save();
      // locals are friendly: they accept a few seconds later
      setTimeout(() => { const g = db.friendships.find(x => x.user_a === a && x.user_b === b); if (g && g.status === 'pending') { g.status = 'accepted'; save(); fire('friendships', 'UPDATE', { ...g }); } }, 6000);
      return 'requested';
    },
    async addFriendByCode(c) {
      const p = Object.values(db.profiles).find(x => x.referral_code === c.toUpperCase());
      if (!p || p.id === ME) throw new Error('No one has that code');
      return this.requestFriend(p.id);
    },
    async removeFriend(u, other) { const [a, b] = pair(u, other); db.friendships = db.friendships.filter(x => !(x.user_a === a && x.user_b === b)); save(); },
    async recentPlayers() {
      const seen = new Map();
      db.events.filter(e => +new Date(e.starts_at) < Date.now() && e.participants.some(p => p.user_id === ME))
        .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))
        .forEach(e => e.participants.forEach(p => { if (p.user_id !== ME && !seen.has(p.user_id) && !blocked(p.user_id)) seen.set(p.user_id, { ...P(p.user_id), last_event: e.title || e.activity, last_played: e.starts_at }); }));
      return later([...seen.values()].slice(0, 8));
    },

    async listVenues() {
      return later(db.venues.map(v => ({
        ...v, manager: P(v.manager_id),
        venue_prices: db.prices.filter(p => p.venue_id === v.id).map(p => ({ ...p, updater: P(p.updated_by) })),
        venue_slots: db.slots.filter(s => s.venue_id === v.id),
        venue_reviews: db.reviews.filter(r => r.venue_id === v.id && !blocked(r.user_id)).map(r => ({ ...r, author: P(r.user_id) }))
      })));
    },
    async createVenue(row) {
      const v = { prices_checked_at: null, manager_verified: false, ...row, id: uid(), created_by: ME, created_at: iso(Date.now()) };
      db.venues.push(v); save(); fire('venues', 'INSERT', v); return later({ id: v.id });
    },
    async updateVenue(id, patch) { Object.assign(venue(id), patch); save(); },
    async claimVenue(id) { const v = venue(id); if (v.manager_id) throw new Error('This venue already has a manager'); v.manager_id = ME; v.manager_verified = false; save(); return true; },
    async savePrice(row) {
      const stamp = { updated_by: ME, updated_at: iso(Date.now()) };
      if (row.id) Object.assign(db.prices.find(p => p.id === row.id), row, stamp);
      else db.prices.push({ note: null, ...row, ...stamp, id: uid(), created_by: ME });
      save();
    },
    async deletePrice(id) { db.prices = db.prices.filter(p => p.id !== id); save(); },
    async confirmPrices(id) { venue(id).prices_checked_at = iso(Date.now()); save(); },
    async addSlot(row) { if (venue(row.venue_id).manager_id !== ME) throw new Error('Only the venue manager can post hours'); db.slots.push({ ...row, id: uid() }); save(); },
    async deleteSlot(id) { db.slots = db.slots.filter(s => s.id !== id); save(); },

    /* reviews + photos */
    async addReview(row) {
      db.reviews = db.reviews.filter(r => !(r.venue_id === row.venue_id && r.user_id === ME)); // one review each, newest wins
      const r = { id: uid(), user_id: ME, photo: null, ...row, created_at: iso(Date.now()) };
      db.reviews.push(r);
      if (!save()) {
        db.reviews.pop(); save();
        throw new Error(row.photo ? 'Your phone is out of space for Pinnit photos. Try without the photo' : 'Could not save your review');
      }
    },
    async deleteReview(id) { db.reviews = db.reviews.filter(r => !(r.id === id && r.user_id === ME)); save(); },

    /* safety: private check-ins after events, reports, blocks */
    async safetyChecks() { return later(db.safety); },
    async saveSafetyCheck(row) { db.safety = db.safety.filter(s => s.event_id !== row.event_id); db.safety.push({ ...row, created_at: iso(Date.now()) }); save(); },
    async report(row) { db.reports.push({ ...row, id: uid(), created_at: iso(Date.now()) }); save(); },
    async blocks() { return later(db.blocks.map(id => P(id) || { id, display_name: 'Member' })); },
    async block(id) {
      if (!db.blocks.includes(id)) db.blocks.push(id);
      db.friendships = db.friendships.filter(f => !(f.user_a === id || f.user_b === id));
      db.events.forEach(e => { if (e.host_id === id) e.participants = e.participants.filter(p => p.user_id !== ME); });
      save();
    },
    async unblock(id) { db.blocks = db.blocks.filter(x => x !== id); save(); },

    /* badges + streaks: everything you've joined or hosted, including finished events */
    async history() {
      return later(db.events.filter(e => e.participants.some(p => p.user_id === ME)).map(e => ({
        id: e.id, title: e.title, category: e.category, activity: e.activity, starts_at: e.starts_at, duration_mins: e.duration_mins,
        hosted: e.host_id === ME, arrived: !!(e.participants.find(p => p.user_id === ME) || {}).arrived_at
      })));
    },
    async reviewCount() { return db.reviews.filter(r => r.user_id === ME).length; },
    async seenBadges() { return db.badges.slice(); },
    async markBadges(ids) { db.badges = [...new Set([...db.badges, ...ids])]; save(); },

    subscribeGlobal(cb) { globalCbs.push(cb); return () => { const i = globalCbs.indexOf(cb); if (i >= 0) globalCbs.splice(i, 1); }; },
    subscribeEvent(id, cb) { (eventCbs[id] = eventCbs[id] || []).push(cb); return () => { eventCbs[id] = (eventCbs[id] || []).filter(x => x !== cb); }; }
  });
})();
