const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getMembers, updateGoldPass } = require('../googlesheets');
const { checkPOTD, loadState, saveState } = require('../potdmonitor');

const GUILD_ID = process.env.DASHBOARD_GUILD_ID || '1362609555900600503';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1545247213800919111';
const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000);
const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = (process.env.DASHBOARD_URL || (publicDomain ? `https://${publicDomain}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

const sessions = new Map();
const oauthStates = new Map();
let started = false;

function parseCookie(header) {
  const out = {};
  for (const item of String(header || '').split(';')) {
    const i = item.indexOf('=');
    if (i > 0) out[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `tufcbot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function currentSession(req) {
  const token = parseCookie(req.headers.cookie).tufcbot_session;
  return token ? sessions.get(token) : null;
}

function requireAuth(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

function isAdmin(guild) {
  if (!guild) return false;
  return guild.owner || (BigInt(guild.permissions || '0') & 0x8n) === 0x8n;
}

async function discordFetch(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...options,
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function oauthFetch(endpoint, body) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OAuth ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function mapMembers(rows) {
  if (!rows || rows.length < 1) return [];
  const headers = rows[0];
  return rows.slice(1).map((row, index) => {
    const member = { sheetRow: 5 + index };
    headers.forEach((header, i) => { if (header) member[String(header).trim()] = row[i] || ''; });
    return member;
  }).filter(m => m.IGN);
}

function daysRemaining(endDateString) {
  const parts = String(endDateString || '').split('/').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  let year = parts[2];
  if (year < 100) year += 2000;
  const end = new Date(year, parts[1] - 1, parts[0]);
  end.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((end - today) / 86400000);
}

function normalizeGoldPass(member) {
  const end = member['GP END DATE'] || '';
  const remaining = daysRemaining(end);
  let status = 'Inactive';
  if (member.GP && !['no', 'false', '0'].includes(String(member.GP).toLowerCase())) {
    status = remaining === null ? 'Active' : remaining < 0 ? 'Expired' : remaining <= 3 ? 'Expiring soon' : 'Active';
  }
  return { ign: member.IGN, gp: member.GP || '', startDate: member['GP START DATE'] || '', endDate: end, remaining, status };
}

function startDashboard(client) {
  if (started) return;
  started = true;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'tufcbot' }));

  app.get('/auth/login', (req, res) => {
    if (!CLIENT_SECRET) return res.status(500).send('Set DISCORD_CLIENT_SECRET in your .env first.');
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, Date.now());
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${BASE_URL}/auth/callback`,
      scope: 'identify guilds',
      state,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const stateTime = oauthStates.get(req.query.state);
      if (!stateTime || Date.now() - stateTime > 10 * 60 * 1000) return res.status(400).send('Invalid or expired OAuth state.');
      oauthStates.delete(req.query.state);
      if (!req.query.code) return res.status(400).send('Missing OAuth code.');
      const token = await oauthFetch('/oauth2/token', {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: `${BASE_URL}/auth/callback`,
      });
      const user = await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
      const guilds = await (await fetch('https://discord.com/api/v10/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
      const guild = Array.isArray(guilds) ? guilds.find(g => g.id === GUILD_ID) : null;
      if (!isAdmin(guild)) return res.status(403).send('You must be a Discord server owner or administrator for the TUFC server.');
      setSession(res, user);
      res.redirect('/');
    } catch (error) {
      console.error('Dashboard OAuth error:', error);
      res.status(500).send('Discord login failed. Check the bot console for details.');
    }
  });

  app.post('/auth/logout', (req, res) => {
    const token = parseCookie(req.headers.cookie).tufcbot_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'tufcbot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.session.user, guildId: GUILD_ID }));

  app.get('/api/overview', requireAuth, async (req, res) => {
    try {
      const rows = await getMembers();
      const members = mapMembers(rows);
      const gps = members.map(normalizeGoldPass);
      const state = loadState();
      res.json({
        memberCount: members.length,
        activeGoldPasses: gps.filter(x => ['Active', 'Expiring soon'].includes(x.status)).length,
        expiringSoon: gps.filter(x => x.status === 'Expiring soon').length,
        expired: gps.filter(x => x.status === 'Expired').length,
        potd: state.potd,
        ppotd: state.ppotd,
        cycle: state.cycle,
        announcementChannelId: state.notificationChannelId,
        mentionRoleId: state.mentionRoleId,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/members', requireAuth, async (req, res) => {
    try {
      const members = mapMembers(await getMembers());
      const q = String(req.query.q || '').trim().toLowerCase();
      const filtered = q ? members.filter(m => Object.values(m).some(v => String(v).toLowerCase().includes(q))) : members;
      res.json(filtered.slice(0, 250));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/goldpasses', requireAuth, async (req, res) => {
    try {
      const gps = mapMembers(await getMembers()).map(normalizeGoldPass);
      const q = String(req.query.q || '').trim().toLowerCase();
      res.json((q ? gps.filter(x => x.ign.toLowerCase().includes(q)) : gps).slice(0, 250));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/goldpass', requireAuth, async (req, res) => {
    try {
      const { ign, start, end } = req.body || {};
      if (!ign || !start || !end) return res.status(400).json({ error: 'IGN, start date and end date are required.' });
      const parts = [start, end].map(v => String(v).split('/').map(Number));
      if (parts.some(p => p.length !== 3 || p.some(Number.isNaN))) return res.status(400).json({ error: 'Use DD/MM/YYYY dates.' });
      const sd = new Date(parts[0][2], parts[0][1] - 1, parts[0][0]);
      const ed = new Date(parts[1][2], parts[1][1] - 1, parts[1][0]);
      if (ed < sd) return res.status(400).json({ error: 'End date cannot be before start date.' });
      const result = await updateGoldPass(String(ign), String(start), String(end));
      if (!result.success) return res.status(404).json({ error: 'Member not found.' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/potd', requireAuth, (req, res) => res.json(loadState()));

  app.post('/api/potd/refresh', requireAuth, async (req, res) => {
    try { const result = await checkPOTD(client, { force: true }); res.json({ ok: true, state: result || loadState() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/potd/settings', requireAuth, async (req, res) => {
    try {
      const state = loadState();
      if (req.body.channelId !== undefined) state.notificationChannelId = req.body.channelId || null;
      if (req.body.roleId !== undefined) state.mentionRoleId = req.body.roleId || null;
      saveState(state);
      res.json(state);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/discord/options', requireAuth, async (req, res) => {
    try {
      const [channels, roles] = await Promise.all([
        discordFetch(`/guilds/${GUILD_ID}/channels`),
        discordFetch(`/guilds/${GUILD_ID}/roles`),
      ]);
      res.json({ channels: channels.filter(c => c.type === 0 || c.type === 5).map(c => ({ id: c.id, name: c.name, type: c.type })), roles: roles.filter(r => !r.managed).map(r => ({ id: r.id, name: r.name })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`🌐 TUFCBOT dashboard running at ${BASE_URL}`));
}

module.exports = { startDashboard };
