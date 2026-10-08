/* =====================================================================
   Pinnit cloud backend client: talks to the Worker at /api (worker/index.js),
   which stores everything in a shared Cloudflare D1 database, so everyone
   sees the same pins, chats and reviews.
   Each phone gets its own account on first open; the token lives in
   localStorage. There is no realtime connection, so changes arrive by
   polling: /api/pulse every 15 s, chat every 4 s while it's open.
   ===================================================================== */
(function () {
  const TOKEN = 'pinnit_token', UID = 'pinnit_uid';
  const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  let token = get(TOKEN), uid = get(UID);
  const sessionOf = () => token && uid ? { user: { id: uid, email: '', user_metadata: {} } } : null;
  const authCbs = [];
  const signedOut = () => { token = uid = null; set(TOKEN, null); set(UID, null); authCbs.forEach(cb => setTimeout(() => cb('SIGNED_OUT', null), 0)); };

  async function req(method, path, body) {
    const r = await fetch('/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null; try { data = await r.json(); } catch {}
    if (r.status === 401 && token) { signedOut(); throw new Error('Please set up Pinnit again'); }
    if (!r.ok) throw new Error((data && data.error) || 'Something went wrong. Try again in a moment');
    return data;
  }
  const blobToDataUrl = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); });
  const uploadDataUrl = async data => (await req('POST', '/photos', { data })).url;
  // the app asks for review count and seen badges together, so share one request
  let progressP = null;
  const progress = () => progressP || (progressP = req('GET', '/progress').finally(() => setTimeout(() => { progressP = null; }, 1000)));

  window.PINNIT_API_FACTORY = () => ({
    deviceAccount: true, cloud: true,
    async getSession() { return sessionOf(); },
    onAuth(cb) { authCbs.push(cb); },
    async createAccount(profile) {
      const r = await req('POST', '/account', profile);
      token = r.token; uid = r.id; set(TOKEN, token); set(UID, uid);
      const s = sessionOf(); authCbs.forEach(cb => setTimeout(() => cb('SIGNED_IN', s), 0));
      return s;
    },
    async signUp() { throw new Error('Use the Get started screen'); },
    async signIn() { throw new Error('Use the Get started screen'); },
    // "Delete my Pinnit": removes the account and everything it made
    async signOut() { try { await req('DELETE', '/me'); } finally { signedOut(); } },
    async resetPassword() {},
    async updatePassword() {},
    async myProfile() { return req('GET', '/me'); },
    async updateProfile(id, patch) { return req('PATCH', '/me', patch); },
    async uploadAvatar(id, blob) { return uploadDataUrl(await blobToDataUrl(blob)); },
    async profile(id) { return req('GET', '/profiles/' + encodeURIComponent(id)); },

    async listEvents() { return req('GET', '/events'); },
    async checkSpot(lat, lng) {
      try { const r = await req('POST', '/check-spot', { lat, lng }); return r && r.reason === 'unavailable' ? null : r; }
      catch { return null; }   // the app then asks OpenStreetMap itself
    },
    async createEvent(row) { return req('POST', '/events', row); },
    async deleteEvent(id) { await req('DELETE', '/events/' + encodeURIComponent(id)); },
    async join(id) { await req('POST', `/events/${encodeURIComponent(id)}/join`); },
    async leave(id) { await req('DELETE', `/events/${encodeURIComponent(id)}/join`); },
    async markArrived(id) { await req('POST', `/events/${encodeURIComponent(id)}/arrived`); },
    async messages(id) { return req('GET', `/events/${encodeURIComponent(id)}/messages`); },
    async sendMessage(id, body) {
      const m = await req('POST', `/events/${encodeURIComponent(id)}/messages`, { body });
      (eventSubs[id] || []).forEach(s => s.emit(m));
    },
    async checkins(id) { return req('GET', `/events/${encodeURIComponent(id)}/checkins`); },
    async checkin(id, u, lat, lng) { await req('PUT', `/events/${encodeURIComponent(id)}/checkin`, { lat, lng }); },
    async stopCheckin(id) { await req('DELETE', `/events/${encodeURIComponent(id)}/checkin`); },

    async friendships() { return req('GET', '/friendships'); },
    async requestFriend(other) { return (await req('POST', '/friends/' + encodeURIComponent(other))).result; },
    async addFriendByCode(code) { return (await req('POST', '/friends/code', { code })).result; },
    async removeFriend(u, other) { await req('DELETE', '/friends/' + encodeURIComponent(other)); },
    async recentPlayers() { return req('GET', '/recent'); },

    async listVenues() { return req('GET', '/venues'); },
    async createVenue(row) { return req('POST', '/venues', row); },
    async updateVenue(id, patch) { await req('PATCH', '/venues/' + encodeURIComponent(id), patch); },
    async claimVenue(id) { await req('POST', `/venues/${encodeURIComponent(id)}/claim`); return true; },
    async savePrice(row) { await req('POST', '/prices', row); },
    async deletePrice(id) { await req('DELETE', '/prices/' + encodeURIComponent(id)); },
    async confirmPrices(id) { await req('POST', `/venues/${encodeURIComponent(id)}/confirm-prices`); },
    async addSlot(row) { await req('POST', '/slots', row); },
    async deleteSlot(id) { await req('DELETE', '/slots/' + encodeURIComponent(id)); },

    async addReview(row) {
      const photo = row.photo && row.photo.startsWith('data:') ? await uploadDataUrl(row.photo) : row.photo || null;
      await req('POST', '/reviews', { ...row, photo });
    },
    async deleteReview(id) { await req('DELETE', '/reviews/' + encodeURIComponent(id)); },

    async safetyChecks() { return req('GET', '/safety'); },
    async saveSafetyCheck(row) { await req('POST', '/safety', row); },
    async report(row) { await req('POST', '/reports', row); },
    async blocks() { return req('GET', '/blocks'); },
    async block(id) { await req('POST', '/blocks/' + encodeURIComponent(id)); },
    async unblock(id) { await req('DELETE', '/blocks/' + encodeURIComponent(id)); },

    async history() { return req('GET', '/history'); },
    async reviewCount() { return (await progress()).reviews; },
    async seenBadges() { return (await progress()).badges; },
    async placesCount() { return (await progress()).places; },
    async markBadges(ids) { await req('POST', '/badges', { ids }); },

    // changes from other phones, by polling
    subscribeGlobal(cb) {
      let since = new Date().toISOString(), version = null, stopped = false;
      const tick = async () => {
        if (stopped || document.hidden || !token) return;
        try {
          const p = await req('GET', '/pulse?since=' + encodeURIComponent(since));
          since = p.at;
          p.joins.forEach(j => cb('participants', { eventType: 'INSERT', new: j }));
          p.friendships.forEach(f => cb('friendships', { eventType: f.status === 'accepted' ? 'UPDATE' : 'INSERT', new: f }));
          if (version != null && p.version !== version && !p.joins.length && !p.friendships.length) cb('events', { eventType: 'UPDATE', new: {} });
          version = p.version;
        } catch (e) { console.warn('pulse', e.message); }
      };
      tick();
      const t = setInterval(tick, 15000);
      return () => { stopped = true; clearInterval(t); };
    },
    subscribeEvent(id, cb) {
      let last = '', stopped = false, n = 0;
      const sub = { emit: m => { if (m.created_at > last) last = m.created_at; cb('message', { new: m }); } };
      (eventSubs[id] = eventSubs[id] || []).push(sub);
      const tick = async () => {
        if (stopped || document.hidden) return;
        try {
          const msgs = await req('GET', `/events/${encodeURIComponent(id)}/messages?after=${encodeURIComponent(last)}`);
          msgs.forEach(sub.emit);
          if (++n % 4 === 0) cb('checkin', {});
        } catch {}
      };
      // start from now: the chat view loads history itself
      last = new Date().toISOString();
      const t = setInterval(tick, 4000);
      return () => { stopped = true; clearInterval(t); eventSubs[id] = (eventSubs[id] || []).filter(x => x !== sub); };
    }
  });
  const eventSubs = {};
})();
