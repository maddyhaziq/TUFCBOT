'use strict';

const fs = require('fs');
const { statePath } = require('./storage');

const EVENTS_URL = 'https://forum.partyinmydorm.com/forums/events.18/';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REMINDER_CHANNEL_IDS = [
    '1362660256987086929', // Admin Channels
    '1413891617957482538', // Members and guests
];
const SINGAPORE_TZ = 'Asia/Singapore';
const PACIFIC_TZ = 'America/Los_Angeles';
const STATE_FILE = statePath('hunt_state.json');
const DAILY_TARGET = 1500;
const PRO_DROP_LIMIT = 3;

let clientRef = null;
let intervalHandle = null;
let checkInProgress = false;
let lastForumScanAt = 0;

function defaultState() {
    return {
        activeHunt: null,
        upcomingHunts: [],
        seenHuntIds: [],
        lastReminderKey: null,
        lastEndAnnouncementKey: null,
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return defaultState();
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            ...defaultState(),
            ...parsed,
            seenHuntIds: Array.isArray(parsed.seenHuntIds) ? parsed.seenHuntIds.map(String) : [],
        };
    } catch (error) {
        console.error('Hunt tracker state load failed:', error);
        return defaultState();
    }
}

function saveState(state) {
    try {
        const tempFile = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
        fs.renameSync(tempFile, STATE_FILE);
    } catch (error) {
        console.error('Hunt tracker state save failed:', error);
    }
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&#x0*27;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function htmlToText(html) {
    return decodeHtml(String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
    });
    if (!response.ok) throw new Error(`PIMD forum returned HTTP ${response.status}`);
    return response.text();
}

function parseThreads(html) {
    const results = [];
    const seen = new Set();
    const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']*threads\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = re.exec(html)) && results.length < 60) {
        const href = decodeHtml(match[1]);
        const title = htmlToText(match[2]);
        const idMatch = href.match(/\.([0-9]+)\/?(?:[?#].*)?$/);
        if (!idMatch || !title) continue;
        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);
        let url;
        try {
            url = new URL(href, 'https://forum.partyinmydorm.com/').toString();
        } catch {
            continue;
        }
        if (!url.includes('/threads/')) continue;
        results.push({ id, title, url });
    }
    return results;
}

function extractFirstPost(html) {
    const patterns = [
        /<div[^>]+class=["'][^"']*\bb bWrapper\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]+class=["'][^"']*\bbbWrapper\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return htmlToText(match[1]);
    }
    return htmlToText(html).slice(0, 16000);
}

function parseDateParts(text) {
    const months = {
        january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
        april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
        august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
        november: 10, nov: 10, december: 11, dec: 11,
    };
    const match = String(text).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i);
    if (!match) return null;
    const month = months[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
    return { year, month, day };
}

function zonedParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

// Converts a wall-clock time in an IANA time zone to an absolute Date.
// Iteration handles the Pacific standard/daylight offset change.
function zonedDateTimeToUtc(parts, timeZone) {
    const desiredUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
    let guess = desiredUtc;
    for (let i = 0; i < 4; i++) {
        const actual = zonedParts(new Date(guess), timeZone);
        const representedUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const delta = desiredUtc - representedUtc;
        if (delta === 0) break;
        guess += delta;
    }
    return new Date(guess);
}

function parseAvailability(text) {
    const availabilityMatch = String(text).match(/EVENT\s+AVAILABILITY([\s\S]{0,500}?)(?=\b(?:INVITE PARTY AVAILABILITY|PARTY AVAILABILITY|$))/i);
    if (!availabilityMatch) return null;
    const block = availabilityMatch[1];
    const dates = block.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\s*[-–—]\s*(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}/i);
    if (!dates) return null;
    const pieces = dates[0].split(/\s*[-–—]\s*/);
    const startParts = parseDateParts(pieces[0]);
    const endParts = parseDateParts(pieces[1]);
    if (!startParts || !endParts) return null;

    const timeMatch = block.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(AM|PM)\s+Pacific(?:\s+Time)?\b/i);
    const hour12 = timeMatch ? Number(timeMatch[1]) % 12 : 12;
    const minute = timeMatch ? Number(timeMatch[2] || 0) : 0;
    const hour = timeMatch && timeMatch[3].toUpperCase() === 'PM' ? hour12 + 12 : hour12;

    const startAt = zonedDateTimeToUtc({ ...startParts, hour, minute, second: 0 }, PACIFIC_TZ);
    const endAt = zonedDateTimeToUtc({ ...endParts, hour, minute, second: 0 }, PACIFIC_TZ);
    if (endAt <= startAt) return null;
    return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

function extractHuntDetails(thread, text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    // Require several event-specific signals. A normal party/event post should not
    // activate the tracker merely because it has an availability date range.
    const hasEventAvailability = /\bEVENT\s+AVAILABILITY\b/i.test(normalized);
    const hasProDrop = /\bPro Party of the Day Drop\b/i.test(normalized);
    const hasHuntBox = /\b(?:Infernal Box|Ornate Autumnal Box|Furniture Box|Hunt Box|Event Box)\b/i.test(normalized);
    if (!hasEventAvailability || !hasProDrop || !hasHuntBox) return null;

    const availability = parseAvailability(normalized);
    if (!availability) return null;

    let box = null;
    // In the supplied announcements the hunt box is named immediately after
    // the Shop Offers marker and before the PPOTD drop section. Avoid matching
    // the earlier descriptive phrase "Infernal Furniture Box" by mistake.
    const beforeProDrop = normalized.split(/Pro Party of the Day Drop/i)[0];
    const boxMatches = [...beforeProDrop.matchAll(/(?:offers\s*!|!|available through)\s*([A-Z][A-Za-z'’ -]{1,55}\bBox)\b/gi)];
    if (boxMatches.length) box = boxMatches[boxMatches.length - 1][1].trim();
    if (!box) {
        const known = normalized.match(/\b(Infernal Box|Ornate Autumnal Box)\b/i);
        if (known) box = known[1];
    }

    let reward = null;
    const rewardMatch = normalized.match(/Pro Party of the Day Drop\s+(?:Complete your PPOTDs and collect your\s+)?(.{2,100}?)(?:!|\.|\bEvil in Residence\b|\bEquinox Your Socks Off\b|$)/i);
    if (rewardMatch) reward = rewardMatch[1].trim().replace(/\s+/g, ' ');

    return {
        id: String(thread.id),
        name: thread.title,
        forumUrl: thread.url,
        startAt: availability.startAt,
        endAt: availability.endAt,
        box,
        reward,
        proDropLimit: PRO_DROP_LIMIT,
        source: 'forum',
        manualOverride: false,
        detectedAt: new Date().toISOString(),
    };
}

function singaporeDateKey(date = new Date()) {
    const p = zonedParts(date, SINGAPORE_TZ);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function singaporeDateParts(date = new Date()) {
    return zonedParts(date, SINGAPORE_TZ);
}

function daysBetweenDateKeys(startKey, endKey) {
    const [sy, sm, sd] = startKey.split('-').map(Number);
    const [ey, em, ed] = endKey.split('-').map(Number);
    return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

function formatSingapore(date) {
    return new Intl.DateTimeFormat('en-SG', {
        timeZone: SINGAPORE_TZ,
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
}

function getHuntDay(hunt, now = new Date()) {
    const start = new Date(hunt.startAt);
    const startKey = singaporeDateKey(start);
    const todayKey = singaporeDateKey(now);
    return daysBetweenDateKeys(startKey, todayKey) + 1;
}

function buildReminder(hunt, day, now) {
    const totalDays = Math.max(1, daysBetweenDateKeys(singaporeDateKey(new Date(hunt.startAt)), singaporeDateKey(new Date(hunt.endAt))) + 1);
    const cumulative = day * DAILY_TARGET;
    const remaining = Math.max(0, totalDays - day);
    const lines = [
        `📅 **Hunt Day:** ${day}/${totalDays}`,
        `🎯 **Daily target per member:** ${DAILY_TARGET.toLocaleString('en-US')} drops`,
        `📊 **Cumulative target per member:** ${cumulative.toLocaleString('en-US')} drops`,
        `⏳ **Days remaining after today:** ${remaining}`,
        `🗓️ **Ends:** ${formatSingapore(new Date(hunt.endAt))} (Singapore time)`,
    ];
    if (hunt.box) lines.push(`📦 **Hunt box:** ${hunt.box}`);
    if (hunt.reward) lines.push(`💎 **PPOTD Pro-drop reward:** ${hunt.reward}`);
    lines.push(`🔗 [Official forum announcement](${hunt.forumUrl})`);
    return {
        content: `🎯 **TUFC HUNT TRACKER — ${hunt.name}**\n${lines.join('\n')}\n\n*In Chaos, We Resonate.*`,
        allowedMentions: { parse: [] },
    };
}

async function sendToBothChannels(payload) {
    if (!clientRef) throw new Error('Hunt tracker Discord client is not ready.');
    const errors = [];
    for (const id of REMINDER_CHANNEL_IDS) {
        try {
            const channel = await clientRef.channels.fetch(id);
            if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
                throw new Error('Channel is not text-based or cannot send messages.');
            }
            await channel.send(payload);
        } catch (error) {
            errors.push(`${id}: ${error.message}`);
            console.error(`Hunt tracker could not post to channel ${id}:`, error.message);
        }
    }
    if (errors.length === REMINDER_CHANNEL_IDS.length) {
        throw new Error(`Could not send hunt notification to either channel: ${errors.join('; ')}`);
    }
}

async function announceHuntStart(hunt) {
    const payload = {
        content:
            `🖤 **NEW PIMD HUNT DETECTED: ${hunt.name}**\n` +
            `📅 **Starts:** ${formatSingapore(new Date(hunt.startAt))} (Singapore time)\n` +
            `🏁 **Ends:** ${formatSingapore(new Date(hunt.endAt))} (Singapore time)\n` +
            `🎯 **Daily target per member:** ${DAILY_TARGET.toLocaleString('en-US')} drops\n` +
            `📊 **Final cumulative target:** ${Math.max(1, daysBetweenDateKeys(singaporeDateKey(new Date(hunt.startAt)), singaporeDateKey(new Date(hunt.endAt))) + 1) * DAILY_TARGET} drops per member\n` +
            (hunt.box ? `📦 **Hunt box:** ${hunt.box}\n` : '') +
            (hunt.reward ? `💎 **PPOTD Pro-drop reward:** ${hunt.reward}\n` : '') +
            `🔗 [Official forum announcement](${hunt.forumUrl})`,
        allowedMentions: { parse: [] },
    };
    await sendToBothChannels(payload);
}

async function scanForum() {
    if (checkInProgress) return;
    checkInProgress = true;

    try {
        const listHtml = await fetchHtml(EVENTS_URL);
        const threads = parseThreads(listHtml);

        if (!threads.length) {
            console.warn('Hunt tracker: forum returned no parseable event threads.');
            return;
        }

        const state = loadState();
        state.seenHuntIds = Array.isArray(state.seenHuntIds)
            ? state.seenHuntIds
            : [];
        state.upcomingHunts = Array.isArray(state.upcomingHunts)
            ? state.upcomingHunts
            : [];

        const candidates = [];
        const now = new Date();

        for (const thread of threads.slice(0, 12)) {
            if (state.seenHuntIds.includes(thread.id)) continue;
            if (state.upcomingHunts.some(item => item.id === thread.id)) continue;

            try {
                const threadHtml = await fetchHtml(thread.url);
                const text = extractFirstPost(threadHtml);
                const hunt = extractHuntDetails(thread, text);

                if (hunt) candidates.push(hunt);
            } catch (error) {
                console.warn(
                    `Hunt tracker could not inspect thread ${thread.id}: ${error.message}`
                );
            }
        }

        candidates.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

        for (const hunt of candidates) {
            // Ignore and record expired historical hunts.
            if (new Date(hunt.endAt) < now) {
                state.seenHuntIds = Array.from(
                    new Set([...state.seenHuntIds, hunt.id])
                ).slice(-200);
                continue;
            }

            const current = state.activeHunt;
            const currentStillActive = current && new Date(current.endAt) >= now;

            // Preserve a manual schedule while it is still active.
            if (current?.manualOverride && currentStillActive) {
                if (!state.upcomingHunts.some(item => item.id === hunt.id)) {
                    state.upcomingHunts.push(hunt);
                }
                continue;
            }

            // Never replace an active hunt with an upcoming hunt.
            if (currentStillActive) {
                if (current.id !== hunt.id &&
                    !state.upcomingHunts.some(item => item.id === hunt.id)) {
                    state.upcomingHunts.push(hunt);
                }
                continue;
            }

            // Activate only hunts whose start time has arrived.
            if (now < new Date(hunt.startAt)) {
                if (!state.upcomingHunts.some(item => item.id === hunt.id)) {
                    state.upcomingHunts.push(hunt);
                }
                continue;
            }

            // Announce before marking the hunt as seen, so failures can retry.
            await announceHuntStart(hunt);

            state.activeHunt = hunt;
            state.lastReminderKey = null;
            state.lastEndAnnouncementKey = null;
            state.seenHuntIds = Array.from(
                new Set([...state.seenHuntIds, hunt.id])
            ).slice(-200);

            state.upcomingHunts = state.upcomingHunts.filter(
                item => item.id !== hunt.id
            );

            saveState(state);
            console.log(`🎯 Hunt activated and announced: ${hunt.name}.`);
            break;
        }

        saveState(state);
    } catch (error) {
        console.error('Hunt forum scan failed (will retry):', error.message);
    } finally {
        checkInProgress = false;
    }
}

async function processSchedule() {
    const state = loadState();
    const now = new Date();

    state.upcomingHunts = Array.isArray(state.upcomingHunts)
        ? state.upcomingHunts
        : [];

    const hunt = state.activeHunt;

    // Process the current hunt if one exists.
    if (hunt) {
        const startAt = new Date(hunt.startAt);
        const endAt = new Date(hunt.endAt);

        if (now < startAt) return;

        const todayKey = singaporeDateKey(now);
        const p = singaporeDateParts(now);

        // Send one reminder per Singapore calendar day, from 3 AM onward.
        if (now <= endAt && state.lastReminderKey !== todayKey) {
            const day = getHuntDay(hunt, now);

            if (day >= 1 && p.hour >= 3) {
                await sendToBothChannels(buildReminder(hunt, day, now));

                state.lastReminderKey = todayKey;
                saveState(state);
                console.log(`🎯 Hunt reminder sent: ${hunt.name}, Day ${day}.`);
            }
        }

        // Retry the end announcement if both channel sends fail.
        if (state.lastEndAnnouncementKey !== String(hunt.id)) {
            await sendToBothChannels({
                content: `🏁 **HUNT ENDED: ${hunt.name}**\nThe official hunt availability window has ended.\n🔗 [Official forum announcement](${hunt.forumUrl})`,
                allowedMentions: { parse: [] },
            });

            state.lastEndAnnouncementKey = String(hunt.id);
            saveState(state);
            console.log(`🏁 Hunt end announcement sent: ${hunt.name}.`);
        }

        // Clear the expired hunt after its end announcement is recorded.
        state.activeHunt = null;
        saveState(state);
    }

    // Promote the earliest eligible queued hunt, even if no active hunt exists.

    const nextHunt = state.upcomingHunts
        .filter(item => new Date(item.endAt) >= now)
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];

    if (!nextHunt) {
        saveState(state);
        return;
    }

    // Wait until the queued hunt's official start time.
    if (now < new Date(nextHunt.startAt)) {
        saveState(state);
        return;
    }

    // Announce before changing state, so a failed announcement can be retried.
    await announceHuntStart(nextHunt);

    state.activeHunt = nextHunt;
    state.upcomingHunts = state.upcomingHunts.filter(
        item => item.id !== nextHunt.id
    );
    state.lastReminderKey = null;
    state.lastEndAnnouncementKey = null;
    state.seenHuntIds = Array.from(
        new Set([...state.seenHuntIds, nextHunt.id])
    ).slice(-200);

    saveState(state);
    console.log(`🎯 Upcoming hunt activated: ${nextHunt.name}.`);
}

async function tick() {
    // Check the forum every five minutes, but evaluate the reminder schedule
    // more frequently so a 3:00 AM reminder isn't missed due to timer drift.
    if (Date.now() - lastForumScanAt >= CHECK_INTERVAL_MS) {
        lastForumScanAt = Date.now();
        await scanForum();
    }
    await processSchedule();
}

function startHuntMonitor(client) {
    clientRef = client;
    if (intervalHandle) clearInterval(intervalHandle);
    // Initial scan shortly after ready. Schedule checks every 30 seconds;
    // forum requests remain limited to one scan per five minutes.
    setTimeout(() => tick().catch(error => console.error('Hunt tracker initial tick failed:', error)), 8000);
    intervalHandle = setInterval(() => {
        tick().catch(error => console.error('Hunt tracker tick failed:', error));
    }, 30 * 1000);
    console.log(`🎯 PIMD Hunt Tracker started; checking ${EVENTS_URL} every 5 minutes; daily reminders at 3:00 AM ${SINGAPORE_TZ}.`);
}

function setManualHunt({ name, startDate, endDate, box = null, reward = null, forumUrl = null }) {
    const parseManualDate = (value) => {
        const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return null;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const check = new Date(Date.UTC(year, month - 1, day));
        if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
        return { year, month: month - 1, day };
    };

    const startParts = parseManualDate(startDate);
    const endParts = parseManualDate(endDate);
    if (!name?.trim()) return { error: 'Hunt name is required.' };
    if (!startParts || !endParts) return { error: 'Use DD/MM/YYYY for both dates.' };

    const startAt = zonedDateTimeToUtc({ ...startParts, hour: 12, minute: 0, second: 0 }, PACIFIC_TZ);
    const endAt = zonedDateTimeToUtc({ ...endParts, hour: 12, minute: 0, second: 0 }, PACIFIC_TZ);
    if (endAt < startAt) return { error: 'End date cannot be before the start date.' };
    if (forumUrl && !/^https:\/\/forum\.partyinmydorm\.com\/threads\//i.test(forumUrl)) {
        return { error: 'Forum URL must be an official PIMD thread URL.' };
    }

    const state = loadState();
    const current = state.activeHunt;
    const idMatch = forumUrl?.match(/\.([0-9]+)\/?(?:[?#].*)?$/);
    const id = idMatch?.[1] || current?.id || `manual-${Date.now()}`;
    const hunt = {
        id: String(id),
        name: name.trim(),
        forumUrl: forumUrl || current?.forumUrl || 'https://forum.partyinmydorm.com/forums/events.18/',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        box: box?.trim() || current?.box || null,
        reward: reward?.trim() || current?.reward || null,
        proDropLimit: PRO_DROP_LIMIT,
        source: 'manual',
        manualOverride: true,
        detectedAt: current?.detectedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    state.activeHunt = hunt;
    state.lastReminderKey = null;
    state.lastEndAnnouncementKey = null;
    state.seenHuntIds = Array.from(new Set([...state.seenHuntIds, String(id)])).slice(-200);
    saveState(state);
    return { hunt, state };
}

function getActiveHunt() {
    return loadState().activeHunt;
}

module.exports = {
    startHuntMonitor,
    setManualHunt,
    getActiveHunt,
    scanForum,
    processSchedule,
    EVENTS_URL,
};
