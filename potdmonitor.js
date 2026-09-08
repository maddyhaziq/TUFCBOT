const fs = require('fs');
const { statePath } = require('./storage');

const THREAD_URL = 'https://forum.partyinmydorm.com/threads/%F0%9F%8C%92parties-of-the-day%F0%9F%8C%92.110277/';
const STATE_FILE = statePath('potd_state.json');
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
const BRUNEI_OFFSET_MS = 8 * 60 * 60 * 1000;

const SPECIAL_POTD_KEY_ITEMS = new Set([
    'Dog Star',
    'Cat Cafe',
    'Pizza Pop (Art)',
    'Bikini',
]);

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {
                cycle: null,
                potd: null,
                ppotd: null,
                announcedPOTD: false,
                announcedPPOTD: false,
                notificationChannelId: null,
                mentionRoleId: null,
                history: [],
            };
        }
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (error) {
        console.error('POTD state load error:', error.message);
        return {
            cycle: null,
            potd: null,
            ppotd: null,
            announcedPOTD: false,
            announcedPPOTD: false,
            notificationChannelId: null,
            mentionRoleId: null,
            history: [],
        };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getCycleKey(date = new Date()) {
    const brunei = new Date(date.getTime() + BRUNEI_OFFSET_MS);

    // PIMD changeover is 3:00 AM Brunei time.
    // Anything before 03:00 belongs to the previous PIMD day.
    if (brunei.getUTCHours() < 3) {
        brunei.setUTCDate(brunei.getUTCDate() - 1);
    }

    const y = brunei.getUTCFullYear();
    const m = String(brunei.getUTCMonth() + 1).padStart(2, '0');
    const d = String(brunei.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
    return decodeEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?\s*>/gi, '\n')
            .replace(/<\/p\s*>/gi, '\n')
            .replace(/<\/div\s*>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n* ').replace(/<\/li\s*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n')
            .trim()
    );
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'TUFCBOT/1.0 POTD Monitor',
            'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`Forum request failed: HTTP ${response.status}`);
    }

    return await response.text();
}

function getLastPageNumber(html) {
    const text = htmlToText(html);
    const match = text.match(/Page\s+\d+\s+of\s+(\d+)/i);
    return match ? Number(match[1]) : null;
}

function normalizePartyName(name) {
    return name
        .replace(/\s+@[^\n]+$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parsePOTDFromTemplate(text) {
    // The tracker uses a colour legend followed by a list of parties.
    // A PRO party can appear before the regular POTD has been identified,
    // so POTD and PPOTD must be detected independently.
    const lines = text
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    const EC_PARTIES = [
        'Dog Star',
        'Cat Cafe',
        'Pizza Pop (Art)',
    ];

    const normalize = value => normalizePartyName(
        value
            .replace(/^[-*•·]\s*/, '')
            .replace(/\s+@[A-Za-z0-9_.-]+$/u, '')
            .trim()
    );

    const isEC = value => EC_PARTIES.some(
        ec => normalize(value).toLowerCase() === ec.toLowerCase()
    );

    const isPro = value => /\(PRO\)\s*(?:@[A-Za-z0-9_.-]+)?$/i.test(value.trim());

    const blocks = [];

    for (let i = 0; i < lines.length; i++) {
        // The forum renders this heading as "Key:" in the current tracker.
        if (!/^Key\s*:?$/i.test(lines[i])) continue;

        const legendIndex = lines.findIndex(
            (line, index) => index > i && /^Not Party Of The Day\s*:?$/i.test(line)
        );
        if (legendIndex === -1) continue;

        const regularIndex = lines.findIndex(
            (line, index) => index > legendIndex && /^Regular Parties\s*:?$/i.test(line)
        );
        if (regularIndex === -1) continue;

        const blockLines = lines.slice(legendIndex + 1, regularIndex);
        const entries = [];

        for (const line of blockLines) {
            if (!/^(?:\*|[-–—•·])\s+/.test(line)) continue;
            const party = normalize(line);
            if (party) entries.push(party);
        }

        // We need the three known EC entries to anchor the current-day list.
        const firstEC = entries.findIndex(e => e.toLowerCase() === EC_PARTIES[0].toLowerCase());
        const secondEC = firstEC >= 0
            ? entries.findIndex((e, idx) => idx > firstEC && e.toLowerCase() === EC_PARTIES[1].toLowerCase())
            : -1;
        const thirdEC = secondEC >= 0
            ? entries.findIndex((e, idx) => idx > secondEC && e.toLowerCase() === EC_PARTIES[2].toLowerCase())
            : -1;

        if (firstEC < 0 || secondEC < 0 || thirdEC < 0) continue;

        const afterEC = entries.slice(thirdEC + 1);
        const proCandidates = afterEC.filter(isPro);
        const nonProCandidates = afterEC.filter(entry => !isPro(entry));

        // PPOTD is independently authoritative: if the PRO party is already
        // posted, record it even when the regular POTD has not appeared yet.
        const ppotd = proCandidates.length ? proCandidates[0] : null;

        // Only use a non-PRO entry as POTD when there is exactly one candidate.
        // This prevents the parser from guessing when the tracker is still
        // showing multiple pending/checking parties.
        const potd = nonProCandidates.length === 1 ? nonProCandidates[0] : null;

        // A block is verified if it has the EC anchor list and at least one
        // authoritative result (POTD or PPOTD). This allows PPOTD to be found
        // first, which is how the current tracker can behave.
        if (!potd && !ppotd) continue;

        blocks.push({ potd, ppotd, entries });
    }

    if (!blocks.length) {
        console.log('🔎 POTD parser: no verified Key block found.');
        return { potd: null, ppotd: null, verified: false, entries: [] };
    }

    const selected = blocks[blocks.length - 1];

    console.log(
        '🔎 POTD parser verified:',
        selected.potd || '(POTD not found yet)',
        '|',
        selected.ppotd || '(PPOTD not found yet)'
    );

    return {
        potd: selected.potd,
        ppotd: selected.ppotd,
        verified: true,
        entries: selected.entries,
    };
}

function parseTestingAndResults(text) {
    const testing = [];
    const failed = [];
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/\btesting\b/i.test(line) || /\bwill test\b/i.test(line)) {
            const possibleParty = line
                .replace(/^.*?\btesting\s*:?\s*/i, '')
                .replace(/^.*?\bwill test\s+/i, '')
                .trim();

            if (possibleParty && possibleParty.length < 80) {
                testing.push(possibleParty);
            }
        }

        if (/\bno drops?\b|\bdid not drop\b|\bnot dropping\b/i.test(line)) {
            const context = lines.slice(Math.max(0, i - 3), i + 1).join(' | ');
            failed.push(context);
        }
    }

    return { testing, failed };
}

async function fetchLatestForumPage() {
    const rootHtml = await fetchText(THREAD_URL);
    const lastPage = getLastPageNumber(rootHtml);

    if (!lastPage) {
        throw new Error('Could not determine the latest POTD forum page.');
    }

    const latestUrl = `${THREAD_URL}page-${lastPage}`;
    const html = await fetchText(latestUrl);

    return {
        page: lastPage,
        url: latestUrl,
        html,
        text: htmlToText(html),
    };
}

function resetForNewCycle(state, cycle) {
    if (state.cycle === cycle) return false;

    state.cycle = cycle;
    state.potd = null;
    state.ppotd = null;
    state.announcedPOTD = false;
    state.announcedPPOTD = false;
    return true;
}

async function checkPOTD(client, options = {}) {
    const state = loadState();
    const cycle = getCycleKey();
    const changedCycle = resetForNewCycle(state, cycle);

    if (changedCycle) saveState(state);

    try {
        const page = await fetchLatestForumPage();
        const result = parsePOTDFromTemplate(page.text);

        if (!result) {
            console.log('⚠️ POTD monitor: Could not parse the current forum template.');
            return { ok: false, state, page };
        }

        const testing = parseTestingAndResults(page.text);
        const oldPOTD = state.potd;
        const oldPPOTD = state.ppotd;

        if (result.verified) {
            // A verified parse is authoritative. Replace the saved values
            // instead of keeping stale data from an earlier bad parse.
            state.potd = result.potd || null;
            state.ppotd = result.ppotd || null;

            if (state.potd !== oldPOTD) {
                state.announcedPOTD = false;
            }

            if (state.ppotd !== oldPPOTD) {
                state.announcedPPOTD = false;
            }

            saveState(state);
        }

        if (options.announce !== false && client) {
            await announceNewResults(client, state, oldPOTD, oldPPOTD, page.url);
        }

        return {
            ok: true,
            state,
            page,
            result,
            testing,
        };
    } catch (error) {
        console.error('❌ POTD monitor check failed:', error.message);
        return { ok: false, state, error };
    }
}

async function announceNewResults(client, state, oldPOTD, oldPPOTD, sourceUrl) {
    if (!state.notificationChannelId) return;

    const channel = await client.channels.fetch(state.notificationChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.error('❌ POTD notification channel is invalid or unavailable.');
        return;
    }

    const mention = state.mentionRoleId ? `<@&${state.mentionRoleId}>` : '';

    if (state.potd && !state.announcedPOTD) {
        const embed = {
            title: '🎉 PARTY OF THE DAY FOUND!',
            description: `**${state.potd}** has been identified as today's Party of the Day.`,
            fields: [
                { name: 'Party', value: state.potd, inline: true },
                { name: 'Type', value: 'POTD', inline: true },
                { name: 'Cycle', value: state.cycle, inline: true },
            ],
            footer: { text: 'TUFCBOT • PIMD POTD Monitor' },
            url: sourceUrl,
        };

        await channel.send({
            content: mention || undefined,
            embeds: [embed],
            allowedMentions: state.mentionRoleId ? { roles: [state.mentionRoleId] } : { parse: [] },
        });

        state.announcedPOTD = true;
        addHistory(state, 'POTD', state.potd);
        saveState(state);
        console.log(`🎉 POTD announced: ${state.potd}`);
    }

    if (state.ppotd && !state.announcedPPOTD) {
        const embed = {
            title: '💎 PRO PARTY OF THE DAY FOUND!',
            description: `**${state.ppotd}** has been identified as today's Pro Party of the Day.`,
            fields: [
                { name: 'Party', value: state.ppotd, inline: true },
                { name: 'Type', value: 'PPOTD', inline: true },
                { name: 'Cycle', value: state.cycle, inline: true },
            ],
            footer: { text: 'TUFCBOT • PIMD POTD Monitor' },
            url: sourceUrl,
        };

        await channel.send({
            content: mention || undefined,
            embeds: [embed],
            allowedMentions: state.mentionRoleId ? { roles: [state.mentionRoleId] } : { parse: [] },
        });

        state.announcedPPOTD = true;
        addHistory(state, 'PPOTD', state.ppotd);
        saveState(state);
        console.log(`💎 PPOTD announced: ${state.ppotd}`);
    }
}

function addHistory(state, type, party) {
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.unshift({
        cycle: state.cycle,
        type,
        party,
        recordedAt: new Date().toISOString(),
    });
    state.history = state.history.slice(0, 30);
}

function startPOTDMonitor(client) {
    console.log('🎉 Starting PIMD POTD monitor...');

    checkPOTD(client);
    setInterval(() => checkPOTD(client), CHECK_INTERVAL);
}

module.exports = {
    checkPOTD,
    startPOTDMonitor,
    loadState,
    saveState,
    getCycleKey,
};
