const fs = require('fs');
const { statePath } = require('./storage');

const STATE_FILE = statePath('ec_timers.json');

const PARTY_INFO = {
  dog: { name: 'Dog Star', emoji: '🐶' },
  cat: { name: 'Cat Cafe', emoji: '🐱' },
  pizza: { name: 'Pizza Pop Art', emoji: '🍕' },
};

const activeTimers = new Map();
let discordClient = null;

function parseDuration(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // HH:MM or HH:MM:SS
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(s)) {
    const p = s.split(':').map(Number);
    const ms = p.length === 2
      ? (p[0] * 60 + p[1]) * 1000
      : (p[0] * 3600 + p[1] * 60 + p[2]) * 1000;
    return ms > 0 ? ms : null;
  }

  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/g;
  let match;
  let consumed = '';
  while ((match = re.exec(s)) !== null) {
    consumed += match[0];
    const n = Number(match[1]);
    const unit = match[2];
    if (/^d/.test(unit)) total += n * 86400000;
    else if (/^h/.test(unit)) total += n * 3600000;
    else if (/^m/.test(unit)) total += n * 60000;
    else total += n * 1000;
  }
  if (!total || consumed.replace(/\s+/g, '') !== s.replace(/\s+/g, '')) return null;
  return Math.round(total);
}

function formatDuration(ms) {
  let seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Failed to read EC timer state:', err);
    return [];
  }
}

function writeState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...activeTimers.values()].map(t => ({
      id: t.id,
      partyKey: t.partyKey,
      partyName: t.partyName,
      emoji: t.emoji,
      ign: t.ign,
      channelId: t.channelId,
      endAt: t.endAt,
      createdAt: t.createdAt,
    })), null, 2));
  } catch (err) {
    console.error('Failed to save EC timer state:', err);
  }
}

function clearTimer(id, persist = true) {
  const timer = activeTimers.get(id);
  if (!timer) return false;
  if (timer.timeout) clearTimeout(timer.timeout);
  activeTimers.delete(id);
  if (persist) writeState();
  return true;
}

async function fireTimer(timer) {
  activeTimers.delete(timer.id);
  writeState();

  try {
    const channel = discordClient?.channels?.cache?.get(timer.channelId)
      || await discordClient?.channels?.fetch(timer.channelId);
    if (!channel || typeof channel.send !== 'function') {
      console.warn(`EC timer ${timer.id}: channel ${timer.channelId} could not be found.`);
      return;
    }

    await channel.send({
      content: `🔔 ${timer.emoji} **${timer.partyName}** — **${timer.ign}** — the EC drop timer is up!`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error(`Failed to send EC timer notification for ${timer.id}:`, err);
  }
}

function scheduleTimer(timer) {
  const delay = Math.max(0, timer.endAt - Date.now());
  timer.timeout = setTimeout(() => void fireTimer(timer), delay);
}

function listTimers(channelId) {
  const now = Date.now();
  return [...activeTimers.values()]
    .filter(t => (!channelId || t.channelId === channelId) && t.endAt > now)
    .sort((a, b) => a.endAt - b.endAt)
    .map(({ timeout, ...timer }) => timer);
}

async function createTimer({ partyKey, durationMs, ign, channel }) {
  const info = PARTY_INFO[partyKey];
  if (!info) throw new Error(`Unknown party timer: ${partyKey}`);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid timer duration.');

  const timer = {
    id: `${partyKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    partyKey,
    partyName: info.name,
    emoji: info.emoji,
    ign: String(ign || '').trim() || 'Unknown',
    channelId: channel?.id,
    endAt: Date.now() + durationMs,
    createdAt: Date.now(),
    timeout: null,
  };

  if (!timer.channelId) throw new Error('Timer channel is unavailable.');
  activeTimers.set(timer.id, timer);
  scheduleTimer(timer);
  writeState();
  return { ...timer, timeout: undefined };
}

function startTimers(client) {
  discordClient = client;
  for (const existing of activeTimers.values()) clearTimeout(existing.timeout);
  activeTimers.clear();

  const now = Date.now();
  for (const saved of readState()) {
    if (!saved || !saved.id || !saved.partyKey || !saved.channelId || !saved.endAt) continue;
    if (!PARTY_INFO[saved.partyKey] || saved.endAt <= now) continue;
    const info = PARTY_INFO[saved.partyKey];
    const timer = {
      ...saved,
      partyName: saved.partyName || info.name,
      emoji: saved.emoji || info.emoji,
      timeout: null,
    };
    activeTimers.set(timer.id, timer);
    scheduleTimer(timer);
  }
  writeState();
  console.log(`⏱️ EC party timers ready (${activeTimers.size} active).`);
}

module.exports = {
  PARTY_INFO,
  parseDuration,
  formatDuration,
  listTimers,
  createTimer,
  startTimers,
};
