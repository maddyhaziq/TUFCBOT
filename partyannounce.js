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
            .setTitle('🎉 EC Parties / LBH — Party Announcement Control')
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

// ───────────── Handlers (return true when the interaction was handled) ─────────────
async function showPartyMenu(interaction) {
    return interaction.reply({ flags: 64, ...menuPayload() });
}

async function handlePartyButton(interaction, isAuthorized) {
    const id = interaction.customId;
    if (id !== 'tufc_hub_party' && !id.startsWith('tufc_party_')) return false;

    if (!(await isAuthorized(interaction))) {
        await interaction.reply({ flags: 64, content: '❌ Only authorized TUFC management roles can use party announcements.' });
        return true;
    }

    if (id === 'tufc_hub_party') { await showPartyMenu(interaction); return true; }
    if (id === 'tufc_party_menu') { await interaction.update(menuPayload()); return true; }

    const [action, partyKey, stage] = id.replace('tufc_party_', '').split(':');
    if (!db.templates[partyKey]) return true;

    if (action === 'open') { await interaction.update(controlsPayload(partyKey)); return true; }

    if (action === 'post') {
        if (!STAGES.includes(stage)) return true;

        // Duplicate protection. This check-and-set runs before any await,
        // so two quick clicks cannot both get through.
        if (db.progress[partyKey][stage]) {
            await interaction.update(controlsPayload(partyKey, `⚠️ **${STAGE_LABEL[stage]}** was already announced.`));
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
            await interaction.update(controlsPayload(partyKey, `✅ **${STAGE_LABEL[stage]}** posted in <#${targetChannelId()}>.`));
        } catch (error) {
            delete db.progress[partyKey][stage]; // unlock so it can be retried
            console.error('Party announcement error:', error);
            await interaction.update(controlsPayload(partyKey, '❌ I could not post there. Check the channel ID and my permissions, then try again.'));
        }
        return true;
    }

    if (action === 'reset') {
        db.progress[partyKey] = {};
        logAudit({ party: partyKey, stage: null, action: 'reset', by: interaction.user.id, tag: interaction.user.tag });
        save();
        await interaction.update(controlsPayload(partyKey, '🔄 Progression reset. Ready for the next party.'));
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
    await interaction.reply({ flags: 64, ...controlsPayload('invite', '✏️ Invite Party wording updated. Cat Cafe and Dog Star are unchanged.') });
    return true;
}

module.exports = { showPartyMenu, handlePartyButton, handlePartyModal, toSmallCaps, buildMessage };
