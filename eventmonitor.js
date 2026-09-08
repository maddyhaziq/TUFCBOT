'use strict';

const fs = require('fs');
const { statePath } = require('./storage');
const { ChannelType } = require('discord.js');

const EVENTS_URL = 'https://forum.partyinmydorm.com/forums/events.18/';
const EVENT_CHANNEL_ID = '1433259589209428091';
const CHECK_INTERVAL = 5 * 60 * 1000;
const STATE_FILE = statePath('event_state.json');

let clientRef = null;
let intervalHandle = null;
let running = false;

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return { initialized: false, seen: [] };
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            initialized: Boolean(state.initialized),
            seen: Array.isArray(state.seen) ? state.seen.map(String) : []
        };
    } catch (error) {
        console.error('Forum event state load failed:', error);
        return { initialized: false, seen: [] };
    }
}

function saveState(state) {
    try {
        const tempFile = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
        fs.renameSync(tempFile, STATE_FILE);
        console.log(`💾 Forum event state saved (${state.seen.length} seen, initialized=${state.initialized})`);
    } catch (error) {
        console.error(`Forum event state save failed (${STATE_FILE}):`, error);
    }
}

function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function getExistingDiscordEventTitles(channel) {
    const titles = new Set();
    if (!(channel.type === ChannelType.GuildForum || channel.type === 15) || !channel.threads) return titles;

    try {
        const active = await channel.threads.fetchActive();
        for (const thread of active.threads.values()) titles.add(normalizeTitle(thread.name));
    } catch (error) {
        console.warn(`Could not fetch active Discord event posts: ${error.message}`);
    }

    try {
        let archived = await channel.threads.fetchArchived({ limit: 100 });
        for (const thread of archived.threads.values()) titles.add(normalizeTitle(thread.name));
    } catch (error) {
        console.warn(`Could not fetch archived Discord event posts: ${error.message}`);
    }

    return titles;
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/')
        .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
    return decodeHtml(String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function absoluteUrl(href) {
    try {
        const value = decodeHtml(href).trim();
        if (!value) return null;
        // XenForo uses site-root-relative thread URLs such as threads/foo.123/.
        // Resolve those against the forum origin, not /forums/events.18/.
        if (value.startsWith('//')) return `https:${value}`;
        if (value.startsWith('/')) return new URL(value, EVENTS_URL).toString();
        if (/^https?:\/\//i.test(value)) return new URL(value).toString();
        if (/^(?:threads|forums|members|search|help)\//i.test(value)) {
            return new URL(`/${value}`, EVENTS_URL).toString();
        }
        return new URL(value, EVENTS_URL).toString();
    } catch {
        return null;
    }
}

function parseEventThreads(html) {
    const results = [];
    const seen = new Set();

    // XenForo can place the href attribute in different positions and may use
    // /forums/events.18/threads/... or /threads/... URLs. Parse every anchor
    // first, then identify thread links from the href itself.
    const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRe.exec(html))) {
        const rawHref = decodeHtml(match[1]);
        if (!/threads(?:\/|\b)/i.test(rawHref)) continue;

        const href = absoluteUrl(rawHref);
        const title = stripTags(match[2]);
        if (!href || !title) continue;
        if (/^Past Events$/i.test(title)) continue;

        // XenForo thread URLs end in .<numeric-id>/ (allow a missing slash too).
        const idMatch = href.match(/\.([0-9]+)\/?(?:\?.*)?(?:#.*)?$/) || href.match(/(?:threads\/)[^?#]+\.([0-9]+)/i);
        if (!idMatch) continue;

        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);

        results.push({ id, title, url: href });
        if (results.length >= 50) break;
    }

    return results;
}

function extractFirstPostHtml(html) {
    // Prefer the first XenForo message body. Keeping the HTML lets us recover
    // the images that belong to the event post instead of unrelated forum icons.
    const selectors = [
        /<div[^>]+class=["'][^"']*bbWrapper[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i
    ];

    for (const re of selectors) {
        const match = html.match(re);
        if (match && match[1]) return match[1];
    }
    return '';
}

function extractFirstPost(html) {
    const bodyHtml = extractFirstPostHtml(html);
    return stripTags(bodyHtml);
}

function extractImageUrls(html) {
    const bodyHtml = extractFirstPostHtml(html);
    if (!bodyHtml) return [];

    const urls = [];
    const seen = new Set();
    const imageRe = /<img\b[^>]*>/gi;
    let match;

    while ((match = imageRe.exec(bodyHtml))) {
        const tag = match[0];
        // XenForo commonly uses src, data-src, data-url, or lazy-load variants.
        const candidates = [];
        const attrRe = /\b(?:src|data-src|data-url|data-original|data-lazy-src)\s*=\s*["']([^"']+)["']/gi;
        let attr;
        while ((attr = attrRe.exec(tag))) candidates.push(attr[1]);

        for (const raw of candidates) {
            const value = decodeHtml(raw).trim();
            if (!value || /^data:/i.test(value) || /^blob:/i.test(value)) continue;
            const url = absoluteUrl(value);
            if (!url || seen.has(url)) continue;

            // Ignore tiny UI/avatar assets where possible. Event artwork is
            // normally an attachment/image URL in the first post body.
            if (/avatar|emoji|smilie|reaction|icon/i.test(url)) continue;

            seen.add(url);
            urls.push(url);
            if (urls.length >= 4) return urls;
        }
    }

    return urls;
}

function extensionFromContentType(contentType, url) {
    const type = String(contentType || '').split(';')[0].toLowerCase();
    const map = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp'
    };
    if (map[type]) return map[type];

    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
        if (match) return match[1].toLowerCase();
    } catch {}
    return 'jpg';
}

async function downloadImage(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': EVENTS_URL
            }
        });
        if (!response.ok) return null;

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('image/')) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        // Keep uploads comfortably below common Discord attachment limits.
        if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;

        return {
            buffer,
            extension: extensionFromContentType(contentType, url)
        };
    } catch (error) {
        console.warn(`Could not download event image ${url}: ${error.message}`);
        return null;
    }
}

function shorten(text, max = 700) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            // PIMD/XenForo can return a different page to custom bot-like UAs.
            // Use a normal browser UA so the forum thread list is returned.
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': 'https://forum.partyinmydorm.com/forums/'
        }
    });
    const html = await response.text();
    console.log(`🌐 Forum fetch: HTTP ${response.status}, ${html.length} bytes, ${response.url}`);
    if (!response.ok) throw new Error(`Forum returned HTTP ${response.status}`);
    return html;
}

async function buildEventEmbed(event) {
    let description = '';
    let imageUrls = [];

    try {
        const threadHtml = await fetchHtml(event.url);
        description = shorten(extractFirstPost(threadHtml));
        imageUrls = extractImageUrls(threadHtml);
    } catch (error) {
        console.error(`Could not read forum event thread ${event.id}:`, error.message);
    }

    const embed = {
        title: `📢 ${event.title}`,
        url: event.url,
        description: description || 'New event announcement posted on the PIMD Forum.',
        color: 0x9b59b6,
        footer: { text: 'TUFCBOT • PIMD Events' }
    };

    // Download the event artwork and attach it to the Discord post. This is
    // more reliable than asking Discord to hotlink PIMD's image CDN.
    const files = [];
    for (let i = 0; i < imageUrls.length; i++) {
        const image = await downloadImage(imageUrls[i]);
        if (!image) continue;
        const filename = `pimd-event-${event.id}-${i + 1}.${image.extension}`;
        files.push({ attachment: image.buffer, name: filename });
    }

    if (files.length) {
        embed.image = { url: `attachment://${files[0].name}` };
        if (files.length > 1) {
            embed.description = `${embed.description}\n\n🖼️ ${files.length} event images included below.`;
        }
    } else if (imageUrls.length) {
        // Fallback if PIMD refuses the bot's image download.
        embed.image = { url: imageUrls[0] };
    }

    return { embed, files };
}

async function postEvent(channel, event) {
    const { embed, files } = await buildEventEmbed(event);

    // The configured Discord destination is a Forum Channel (type 15),
    // so it cannot receive a normal channel.send(). Create a Forum Post
    // instead. Each PIMD event becomes its own Discord forum post.
    if (channel.type === ChannelType.GuildForum || channel.type === 15) {
        if (!channel.threads?.create) {
            throw new Error(`Discord event channel ${EVENT_CHANNEL_ID} is a Forum Channel, but forum post creation is unavailable. Check the bot's permissions.`);
        }

        const postName = String(event.title || `PIMD Event ${event.id}`)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100);

        const created = await channel.threads.create({
            name: postName,
            message: { embeds: [embed], files },
            reason: `TUFCBOT PIMD Events monitor — forum thread ${event.id}`
        });

        console.log(`📌 Created Discord forum post: ${created.name} (${created.id}) ← PIMD event ${event.id}`);
        return created;
    }

    if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
        throw new Error(`Discord event channel ${EVENT_CHANNEL_ID} is ${channel.type ?? 'unknown'} and cannot receive messages or forum posts.`);
    }

    await channel.send({ embeds: [embed], files });
}

async function checkForumEvents({ initial = false } = {}) {
    if (running) return;
    running = true;

    try {
        const html = await fetchHtml(EVENTS_URL);
        const events = parseEventThreads(html);
        if (!events.length) {
            console.warn('Forum event monitor found no event threads.');
            console.warn(`Forum page contained ${ (html.match(/threads(?:\/|\b)/gi) || []).length } thread references.`);
            const sample = html.match(/.{0,120}threads.{0,180}/i);
            if (sample) console.warn(`Forum thread sample: ${sample[0].replace(/\s+/g, ' ').slice(0, 300)}`);
            return;
        }

        const channel = await clientRef.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
        if (!channel) {
            throw new Error(`Discord event channel ${EVENT_CHANNEL_ID} could not be found. Check the channel ID and that the bot can see the channel.`);
        }
        const channelTypeLabel = channel.type === ChannelType.GuildForum || channel.type === 15
            ? 'Forum Channel'
            : (channel.type ?? 'unknown');

        if (channel.type === ChannelType.GuildForum || channel.type === 15) {
            console.log(`📡 Event destination resolved: ${channel.name || EVENT_CHANNEL_ID} (${channelTypeLabel}). Forum posts will be created for events.`);
        } else if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
            throw new Error(`Discord event channel ${EVENT_CHANNEL_ID} is ${channelTypeLabel} and cannot receive messages. Use a Text Channel or Forum Channel.`);
        } else {
            console.log(`📡 Event destination resolved: ${channel.name || EVENT_CHANNEL_ID} (${channelTypeLabel}).`);
        }

        const state = loadState();
        console.log(`💾 Forum event state loaded from ${STATE_FILE}: initialized=${state.initialized}, seen=${state.seen.length}`);

        // Discord is a second layer of protection. If event_state.json was
        // deleted, reset, or failed to persist during an earlier version,
        // don't create another Forum Post when one with the same title already
        // exists. This is especially important for restarts.
        const existingDiscordTitles = await getExistingDiscordEventTitles(channel);
        const discordMatchedIds = events
            .filter(event => existingDiscordTitles.has(normalizeTitle(event.title)))
            .map(event => event.id);
        if (discordMatchedIds.length) {
            const merged = Array.from(new Set([...state.seen, ...discordMatchedIds])).slice(-100);
            if (merged.length !== state.seen.length) {
                state.seen = merged;
                saveState(state);
            }
            console.log(`🛡️ Discord duplicate protection matched ${discordMatchedIds.length} existing event post(s).`);
        }

        if (!state.initialized) {
            // First run: post the latest three events, but skip anything that
            // already exists in Discord (protects against state-file loss).
            const latestThree = events.slice(0, 3);
            const toPost = latestThree.filter(event => !state.seen.includes(event.id));
            console.log(`📢 Initial scan: ${latestThree.length} latest event(s), ${toPost.length} need Discord posts.`);
            for (const event of [...toPost].reverse()) {
                await postEvent(channel, event);
                state.seen = Array.from(new Set([...state.seen, event.id])).slice(-100);
                saveState(state);
            }
            // Remember all currently visible events so older page-1 threads are
            // not announced later just because they were not in the latest 3.
            state.seen = Array.from(new Set([...state.seen, ...events.map(e => e.id)])).slice(-100);
            state.initialized = true;
            saveState(state);
            return;
        }

        const unseen = events.filter(event => !state.seen.includes(event.id));
        if (!unseen.length) return;

        // Post oldest first when multiple new event threads appeared between checks.
        for (const event of unseen.reverse()) {
            await postEvent(channel, event);
            // Persist after every successful post, not after the whole batch.
            // If Discord or the process fails midway, already-posted events
            // remain recorded and will not be duplicated on restart.
            state.seen = Array.from(new Set([...state.seen, event.id])).slice(-100);
            saveState(state);
        }
    } catch (error) {
        console.error('Forum event monitor failed:', error);
    } finally {
        running = false;
    }
}

function startEventMonitor(client) {
    clientRef = client;
    if (intervalHandle) clearInterval(intervalHandle);

    setTimeout(() => {
        checkForumEvents({ initial: true }).catch(error => console.error('Initial forum event check failed:', error));
    }, 5000);

    intervalHandle = setInterval(() => {
        checkForumEvents().catch(error => console.error('Forum event check failed:', error));
    }, CHECK_INTERVAL);

    console.log(`📢 PIMD forum event monitor started → Discord channel ${EVENT_CHANNEL_ID}`);
}

module.exports = {
    startEventMonitor,
    checkForumEvents,
    EVENT_CHANNEL_ID,
    EVENTS_URL
};
