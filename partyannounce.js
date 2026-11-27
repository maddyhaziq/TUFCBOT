'use strict';

// partyannounce.js — EC Party / LBH progression announcements for the TUFC Member Hub.
// Cat Cafe, Dog Star and Invite Parties: manual stage buttons, duplicate protection,
// reset, editable Invite Party wording, and an audit trail. State lives on the
// Railway volume through storage.js, like ec_timers.json and potd_state.json.

const fs = require('fs');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { statePath } = require('./storage');

const STATE_FILE = 'party_announcements.json';
const AUDIT_LIMIT = 1000;

// Panels are public (everyone in the channel can watch progress) and delete themselves
// 5 minutes after the last button press. Progress itself is saved, so reopening shows the same ticks.
const PANEL_TTL_MS = Number(process.env.PARTY_PANEL_TTL_MS) || 5 * 60 * 1000;
const panelTimers = new Map();
function schedulePanelDelete(message) {
    if (!message) return;
    clearTimeout(panelTimers.get(message.id));
    const timer = setTimeout(() => {
        panelTimers.delete(message.id);
        message.delete().catch(() => {});
    }, PANEL_TTL_MS);
    if (timer.unref) timer.unref();
    panelTimers.set(message.id, timer);
}
async function openPanel(interaction, payload) {
    await interaction.reply(payload); // public
    schedulePanelDelete(await interaction.fetchReply().catch(() => null));
}
async function updatePanel(interaction, payload) {
    await interaction.update(payload);
    schedulePanelDelete(interaction.message);
}

// Same destination pattern as the LBH Call buttons. Set PARTY_CHANNEL_ID to post elsewhere.
const DEFAULT_CHANNEL_ID = '1433477225251995740';
const targetChannelId = () => process.env.PARTY_CHANNEL_ID || process.env.LBH_CHANNEL_ID || DEFAULT_CHANNEL_ID;

const STAGES = ['drop', '2.0', '1.5', '1.0', '0.5', 'end'];
const STAGE_LABEL = { drop: 'Dropped', '2.0': '2.0', '1.5': '1.5', '1.0': '1.0', '0.5': '0.5', end: 'Ended' };

// Each party owns its own template, so editing Invite Parties never touches the others.
const DEFAULT_TEMPLATES = {
    catcafe: { title: 'Cat Cafe', emoji: '🐱', name: 'Cat Cafe', stageEmoji: '🐱🌙', drop: 'Cat dropped', end: 'Cat got out of the bag' },
    dogstar: { title: 'Dog Star', emoji: '🐶', name: 'Dog Star', stageEmoji: '🐶🌙🏎️', drop: 'Doggies dropped', end: 'Who let the dogs out?' },
    invite:  { title: 'Invite Parties', emoji: '💌', name: 'Invite Party', stageEmoji: '💌✨', drop: 'Invite party dropped', end: 'Invite party has ended' },
};
const PARTY_KEYS = Object.keys(DEFAULT_TEMPLATES);

// LBH-style panels: Regular Parties LBH (the old LBH Call buttons) and Pro Testing.
// Both ping the LBH role in the LBH channel; set PRO_TEST_ROLE_ID / PRO_TEST_CHANNEL_ID to change that for Pro Testing.
const S = (key, id, label, emoji, style, line) => ({ key, id, label, emoji, style, line });
const LBH_PANELS = {
    regular: {
        title: '📣 Regular Parties LBH',
        hubId: 'tufc_hub_lbh', resetId: 'tufc_lbh_reset',
        intro: 'Press each stage to call the @LBH hitters.',
        endKey: 'done', endedText: 'Party finished. Press **Reset** for the next party.',
        roleEnv: 'LBH_ROLE_ID', channelEnv: 'LBH_CHANNEL_ID',
        next: ['2.0', '1.5', '1.0', '0.5', 'done'],
        rows: [['2.0', '1.5', '1.0', '0.5'], ['ppotd', 'potd', 'done']],
        stages: [
            S('2.0', 'tufc_lbh_2', '2.0', '📣', 'primary', r => `📣 ${r} — **2.0 Bar!** The party is heating up. Start getting ready to hit.`),
            S('1.5', 'tufc_lbh_15', '1.5', '📣', 'primary', r => `📣 ${r} — **1.5 Bar!** Getting closer. Hitters, get into position.`),
            S('1.0', 'tufc_lbh_1', '1.0', '📣', 'primary', r => `📣 ${r} — **1.0 Bar!** Almost there. Hitters, fingers on the button.`),
            S('0.5', 'tufc_lbh_05', '0.5', '📣', 'primary', r => `📣 ${r} — **0.5 Bar — final call!** The last bar is almost here. Hit it now!`),
            S('ppotd', 'tufc_lbh_ppotd', 'LBH PPOTD Start', '🔔', 'secondary', r => `🔔 ${r} — **PPOTD has started!** Hitters, the pro party is open. Go hit it!`),
            S('potd', 'tufc_lbh_potd', 'LBH POTD Start', '🔔', 'secondary', r => `🔔 ${r} — **POTD has started!** Hitters, today's party is open. Go hit it!`),
            S('done', 'tufc_lbh_done', 'Party Finished', '✅', 'success', r => `✅ ${r} — **Party is finished!**`),
        ],
    },
    protest: {
        title: '🧪 Pro Testing',
        hubId: 'tufc_hub_protest', resetId: 'tufc_pt_reset',
        intro: 'Press each stage to update the testers.',
        endKey: 'ended', endedText: 'Pro Testing ended. Press **Reset** for the next test.',
        roleEnv: 'PRO_TEST_ROLE_ID', roleFallbackEnv: 'LBH_ROLE_ID', channelEnv: 'PRO_TEST_CHANNEL_ID', channelFallbackEnv: 'LBH_CHANNEL_ID',
        next: ['started', '2.0', '1.5', '1.0', '0.5', 'ended'],
        rows: [['started', '2.0', '1.5', '1.0'], ['0.5', 'ended']],
        stages: [
            S('started', 'tufc_pt_started', 'Pro Testing Started', '🧪', 'success', r => `🧪 ${r} — **Pro Testing has started!** Testers, get ready. Let's find out if this one is Pro.`),
            S('2.0', 'tufc_pt_2', '2.0', '🧪', 'primary', r => `🧪 ${r} — **Pro Test 2.0 Bar!** Testing is underway. Keep your eyes on the bar.`),
            S('1.5', 'tufc_pt_15', '1.5', '🧪', 'primary', r => `🧪 ${r} — **Pro Test 1.5 Bar!** Stay sharp, testers. We're past the halfway mark.`),
            S('1.0', 'tufc_pt_1', '1.0', '🧪', 'primary', r => `🧪 ${r} — **Pro Test 1.0 Bar!** Getting close. Be ready to check the result.`),
            S('0.5', 'tufc_pt_05', '0.5', '🧪', 'primary', r => `🧪 ${r} — **Pro Test 0.5 Bar — final stretch!** Hold steady, almost there.`),
            S('ended', 'tufc_pt_ended', 'Pro Testing Ended', '✅', 'danger', r => `✅ ${r} — **Pro Testing has ended!** Thank you to everyone who tested.`),
        ],
    },
};
const BUTTON_STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

// ───────────── MonoUppercase (Unicode small caps) ─────────────
const SMALL_CAPS = {
    a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ',
    n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
};
// Keep Discord custom emoji (<:name:id>) and :shortcodes: intact so they still render.
const PROTECTED = /(<a?:\w+:\d+>|:\w+:)/g;
function toSmallCaps(text) {
    return String(text).split(PROTECTED).map((part, i) =>
        i % 2 === 1 ? part : [...part].map(ch => SMALL_CAPS[ch.toLowerCase()] ?? ch).join('')
    ).join('');
}

// ───────────── State ─────────────
let db = { templates: {}, progress: {}, audit: [] };
function load() {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(statePath(STATE_FILE), 'utf8')) }; } catch (_) { /* first run */ }
    for (const key of PARTY_KEYS) {
        db.templates[key] = { ...DEFAULT_TEMPLATES[key], ...(db.templates[key] || {}) };
        db.progress[key] = db.progress[key] || {};
    }
    for (const key of Object.keys(LBH_PANELS)) db.progress[key] = db.progress[key] || {};
    db.audit = Array.isArray(db.audit) ? db.audit : [];
}
function save() {
    if (db.audit.length > AUDIT_LIMIT) db.audit = db.audit.slice(-AUDIT_LIMIT);
    fs.writeFileSync(statePath(STATE_FILE), JSON.stringify(db, null, 2));
}
load();

function buildMessage(partyKey, stage) {
    const t = db.templates[partyKey];
    const line = stage === 'drop' ? `${t.name} — ${t.drop}`
        : stage === 'end' ? `${t.name} — ${t.end}`
        : `${t.name} — ${stage} ${t.stageEmoji}`;
    return toSmallCaps(line);
}

function logAudit(entry) {
    db.audit.push({ ...entry, at: new Date().toISOString() });
}

// ───────────── Menus ─────────────
function menuPayload() {
    return {
        embeds: [new EmbedBuilder()
            .setTitle('🎉 EC Parties LBH — Announcement Control')
            .setDescription('Pick a party, then press each stage button when it is time to announce it. Nothing is posted automatically.')],
        components: [new ActionRowBuilder().addComponents(
            ...PARTY_KEYS.map(key => new ButtonBuilder()
                .setCustomId(`tufc_party_open:${key}`)
                .setLabel(db.templates[key].title)
                .setEmoji(DEFAULT_TEMPLATES[key].emoji)
                .setStyle(ButtonStyle.Primary))
        )],
    };
}

function controlsPayload(partyKey, notice = '') {
    const t = db.templates[partyKey];
    const posted = db.progress[partyKey];
    const done = STAGES.filter(s => posted[s]).length;
    const next = STAGES.find(s => !posted[s]);

    const stageButton = stage => new ButtonBuilder()
        .setCustomId(`tufc_party_post:${partyKey}:${stage}`)
        .setLabel(posted[stage] ? `${STAGE_LABEL[stage]} ✓` : STAGE_LABEL[stage])
        .setStyle(posted[stage] ? ButtonStyle.Secondary : stage === 'end' ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(!!posted[stage]);

    const row1 = new ActionRowBuilder().addComponents(...STAGES.slice(0, 5).map(stageButton));
    const row2 = new ActionRowBuilder().addComponents(
        stageButton('end'),
        new ButtonBuilder().setCustomId(`tufc_party_reset:${partyKey}`).setLabel('Reset').setEmoji('🔄').setStyle(ButtonStyle.Danger).setDisabled(done === 0),
        ...(partyKey === 'invite'
            ? [new ButtonBuilder().setCustomId('tufc_party_edit:invite').setLabel('Edit wording').setEmoji('✏️').setStyle(ButtonStyle.Secondary)]
            : []),
        new ButtonBuilder().setCustomId('tufc_party_menu').setLabel('Back').setStyle(ButtonStyle.Secondary),
    );

    const history = STAGES.filter(s => posted[s]).map(s => {
        const p = posted[s];
        return `✓ **${STAGE_LABEL[s]}** — <@${p.by}> <t:${Math.floor(new Date(p.at).getTime() / 1000)}:t>`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`${DEFAULT_TEMPLATES[partyKey].emoji} ${t.title}`)
        .setDescription([
            notice,
            `**${done}/${STAGES.length}** announced`,
            next ? `**Next:** ${buildMessage(partyKey, next)}` : 'All stages announced. Press **Reset** to start another party.',
            history.length ? `\n${history.join('\n')}` : '',
        ].filter(Boolean).join('\n'));

    return { embeds: [embed], components: [row1, row2] };
}


// ───────────── LBH-style panels (Regular Parties LBH, Pro Testing) ─────────────
function lbhPanelPayload(panelKey, notice = '') {
    const def = LBH_PANELS[panelKey];
    const posted = db.progress[panelKey];
    const byKey = Object.fromEntries(def.stages.map(st => [st.key, st]));
    const next = posted[def.endKey] ? undefined : def.next.find(k => !posted[k]);
    const anyPosted = def.stages.some(st => posted[st.key]);

    const button = key => {
        const st = byKey[key];
        const done = !!posted[key];
        return new ButtonBuilder()
            .setCustomId(st.id)
            .setLabel(done ? `${st.label} ✓` : st.label)
            .setEmoji(st.emoji)
            .setStyle(done ? ButtonStyle.Secondary : BUTTON_STYLE[st.style])
            .setDisabled(done);
    };

    const history = def.stages.filter(st => posted[st.key]).map(st => {
        const p = posted[st.key];
        return `✓ **${st.label}** — <@${p.by}> <t:${Math.floor(new Date(p.at).getTime() / 1000)}:t>`;
    });

    const embed = new EmbedBuilder()
        .setTitle(def.title)
        .setDescription([
            notice || def.intro,
            next ? `**Next:** ${byKey[next].label}` : def.endedText,
            history.length ? `\n${history.join('\n')}` : '',
        ].filter(Boolean).join('\n'));

    return {
        embeds: [embed],
        components: [
            ...def.rows.map(row => new ActionRowBuilder().addComponents(...row.map(button))),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(def.resetId).setLabel('Reset').setEmoji('🔄').setStyle(ButtonStyle.Danger).setDisabled(!anyPosted)),
        ],
    };
}

function findLbhPanel(id) {
    for (const [panelKey, def] of Object.entries(LBH_PANELS)) {
        if (id === def.hubId) return { panelKey, def, action: 'open' };
        if (id === def.resetId) return { panelKey, def, action: 'reset' };
        const stage = def.stages.find(st => st.id === id);
        if (stage) return { panelKey, def, action: 'post', stage };
    }
    return null;
}

async function handleLbhButton(interaction) {
    const found = findLbhPanel(interaction.customId);
    if (!found) return false;
    const { panelKey, def, action, stage } = found;

    if (action === 'open') { await openPanel(interaction, lbhPanelPayload(panelKey)); return true; }

    if (action === 'reset') {
        db.progress[panelKey] = {};
        logAudit({ party: panelKey, stage: null, action: 'reset', by: interaction.user.id, tag: interaction.user.tag });
        save();
        await updatePanel(interaction, lbhPanelPayload(panelKey, '🔄 Progression reset. Ready for the next one.'));
        return true;
    }

    const roles = interaction.guild?.roles.cache;
    const roleId = process.env[def.roleEnv] || (def.roleFallbackEnv && process.env[def.roleFallbackEnv]);
    const role = (roleId && roles?.get(roleId)) || roles?.find(r => r.name.toLowerCase() === 'lbh');
    if (!role) {
        await updatePanel(interaction, lbhPanelPayload(panelKey, '❌ I could not find the **LBH** role. Set `LBH_ROLE_ID` in your .env or name the role exactly `LBH`.'));
        return true;
    }

    // Duplicate protection (check-and-set before any await).
    if (db.progress[panelKey][stage.key]) {
        await updatePanel(interaction, lbhPanelPayload(panelKey, `⚠️ **${stage.label}** was already announced.`));
        return true;
    }
    const record = { by: interaction.user.id, tag: interaction.user.tag, at: new Date().toISOString() };
    db.progress[panelKey][stage.key] = record;

    const channelId = process.env[def.channelEnv] || (def.channelFallbackEnv && process.env[def.channelFallbackEnv]) || DEFAULT_CHANNEL_ID;
    try {
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') throw new Error(`Cannot access channel ${channelId}`);
        const sent = await channel.send({ content: stage.line(role), allowedMentions: { roles: [role.id] } });
        record.messageId = sent.id;
        logAudit({ party: panelKey, stage: stage.key, action: 'post', by: record.by, tag: record.tag, messageId: sent.id });
        save();
        await updatePanel(interaction, lbhPanelPayload(panelKey, `✅ **${stage.label}** posted in <#${channelId}>.`));
    } catch (error) {
        delete db.progress[panelKey][stage.key]; // unlock so it can be retried
        console.error(`${def.title} error:`, error);
        await updatePanel(interaction, lbhPanelPayload(panelKey, `❌ I could not post in <#${channelId}>. Check the channel ID and my permissions, then try again.`));
    }
    return true;
}

// ───────────── Handlers (return true when the interaction was handled) ─────────────
async function showPartyMenu(interaction) {
    return openPanel(interaction, menuPayload());
}

async function handlePartyButton(interaction, isAuthorized) {
    const id = interaction.customId;
    if (findLbhPanel(id)) return handleLbhButton(interaction);
    if (id !== 'tufc_hub_party' && !id.startsWith('tufc_party_')) return false;

    if (!(await isAuthorized(interaction))) {
        await interaction.reply({ flags: 64, content: '❌ Only authorized TUFC management roles can use party announcements.' });
        return true;
    }

    if (id === 'tufc_hub_party') { await showPartyMenu(interaction); return true; }
    if (id === 'tufc_party_menu') { await updatePanel(interaction, menuPayload()); return true; }

    const [action, partyKey, stage] = id.replace('tufc_party_', '').split(':');
    if (!db.templates[partyKey]) return true;

    if (action === 'open') { await updatePanel(interaction, controlsPayload(partyKey)); return true; }

    if (action === 'post') {
        if (!STAGES.includes(stage)) return true;

        // Duplicate protection. This check-and-set runs before any await,
        // so two quick clicks cannot both get through.
        if (db.progress[partyKey][stage]) {
            await updatePanel(interaction, controlsPayload(partyKey, `⚠️ **${STAGE_LABEL[stage]}** was already announced.`));
            return true;
        }
        const record = { by: interaction.user.id, tag: interaction.user.tag, at: new Date().toISOString() };
        db.progress[partyKey][stage] = record;

        try {
            const channel = await interaction.guild.channels.fetch(targetChannelId()).catch(() => null);
            if (!channel || typeof channel.send !== 'function') throw new Error(`Cannot access channel ${targetChannelId()}`);
            const sent = await channel.send({ content: buildMessage(partyKey, stage), allowedMentions: { parse: [] } });
            record.messageId = sent.id;
            logAudit({ party: partyKey, stage, action: 'post', by: record.by, tag: record.tag, messageId: sent.id });
            save();
            await updatePanel(interaction, controlsPayload(partyKey, `✅ **${STAGE_LABEL[stage]}** posted in <#${targetChannelId()}>.`));
        } catch (error) {
            delete db.progress[partyKey][stage]; // unlock so it can be retried
            console.error('Party announcement error:', error);
            await updatePanel(interaction, controlsPayload(partyKey, '❌ I could not post there. Check the channel ID and my permissions, then try again.'));
        }
        return true;
    }

    if (action === 'reset') {
        db.progress[partyKey] = {};
        logAudit({ party: partyKey, stage: null, action: 'reset', by: interaction.user.id, tag: interaction.user.tag });
        save();
        await updatePanel(interaction, controlsPayload(partyKey, '🔄 Progression reset. Ready for the next party.'));
        return true;
    }

    if (action === 'edit' && partyKey === 'invite') {
        const t = db.templates.invite;
        const input = (id, label, value, max, required = true) => new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
                .setValue(String(value || '')).setMaxLength(max).setRequired(required));
        await interaction.showModal(new ModalBuilder().setCustomId('tufc_modal_party_invite').setTitle('Edit Invite Party wording').addComponents(
            input('name', 'Party name', t.name, 60),
            input('stageEmoji', 'Emojis for 2.0 / 1.5 / 1.0 / 0.5', t.stageEmoji, 40, false),
            input('drop', 'Drop announcement text', t.drop, 100),
            input('end', 'Ending announcement text', t.end, 100),
        ));
        return true;
    }

    return true;
}

async function handlePartyModal(interaction, isAuthorized) {
    if (interaction.customId !== 'tufc_modal_party_invite') return false;
    if (!(await isAuthorized(interaction))) {
        await interaction.reply({ flags: 64, content: '❌ Only authorized TUFC management roles can edit party wording.' });
        return true;
    }
    const t = db.templates.invite;
    const get = key => interaction.fields.getTextInputValue(key).trim();
    t.name = get('name') || t.name;
    t.stageEmoji = get('stageEmoji');
    t.drop = get('drop') || t.drop;
    t.end = get('end') || t.end;
    logAudit({ party: 'invite', stage: null, action: 'edit-template', by: interaction.user.id, tag: interaction.user.tag });
    save();
    const payload = controlsPayload('invite', '✏️ Invite Party wording updated. Cat Cafe and Dog Star are unchanged.');
    if (interaction.isFromMessage && interaction.isFromMessage()) await updatePanel(interaction, payload);
    else await interaction.reply({ flags: 64, ...payload });
    return true;
}

module.exports = { showPartyMenu, handlePartyButton, handlePartyModal, toSmallCaps, buildMessage };
