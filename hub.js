const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UserSelectMenuBuilder,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const { checkPOTD, loadState } = require('./potdmonitor');
const {
    getMembers,
    updateGoldPass,
    removeGoldPass,
    updateMemberIGN,
    addMember,
    deleteMember,
    updateMemberRole,
    updateMemberDiscordId,
    updateMemberStats,
} = require('./googlesheets');
const { PARTY_INFO, parseDuration, formatDuration, listTimers, createTimer } = require('./timers');
const { solveDormUpgrade } = require('./dorm_calculator');

const MANAGEMENT_CHANNEL_ID = '1546018842357010452';
const MANAGEMENT_THREAD_ID = '1362653602006696056';
// Curated management announcements are always delivered to this channel.
const ANNOUNCEMENT_CHANNEL_IDS = ['1413891617957482538', '1546720584468013196'];
const ANNOUNCEMENT_CHANNEL_ID = ANNOUNCEMENT_CHANNEL_IDS[0];

// Short-lived announcement drafts are kept in memory between the composer modal
// and the destination-channel picker. They expire automatically so old drafts
// cannot accumulate in a long-running bot process.
const pendingAnnouncements = new Map();
const ANNOUNCEMENT_DRAFT_TTL_MS = 10 * 60 * 1000;

function createAnnouncementDraftId(userId) {
    return `${userId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function isValidHttpUrl(value) {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function getAnnouncementModal() {
    const modal = new ModalBuilder()
        .setCustomId('tufc_modal_announcement')
        .setTitle('Create TUFC Announcement');

    // Discord modal submissions currently accept Text Input components here.
    // Direct file uploads are handled by the /announcement command instead.
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('title')
                .setLabel('Announcement Title')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('Short title for the announcement')
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('message')
                .setLabel('Announcement Message')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('Write the announcement here...')
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('image_url')
                .setLabel('Image URL (optional)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setPlaceholder('https://example.com/image.jpg')
        )
    );

    return modal;
}

function announcementChannelPicker(draftId) {
    return new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId(`tufc_announcement_channel:${draftId}`)
            .setPlaceholder('Choose where to post the announcement')
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    );
}

function cleanupAnnouncementDrafts() {
    const cutoff = Date.now() - ANNOUNCEMENT_DRAFT_TTL_MS;
    for (const [id, draft] of pendingAnnouncements) {
        if (draft.createdAt < cutoff) pendingAnnouncements.delete(id);
    }
}
const MANAGEMENT_ROLES = new Set([
    'President 🐉',
    'Vice-President 『♕』',
    'The Executive『♗』',
    'The Kicker 『♖』',
    'The Party Jockey 『♘』',
    'Club Admin 👮🏻‍♂️',
    'Club Rep',
    'Club Representative'
]);

// Parse DD/MM/YY or DD/MM/YYYY safely.
function parseDate(dateString) {
    if (!dateString) return null;
    const parts = String(dateString).trim().split('/');
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    let year = parseInt(parts[2], 10);
    if ([day, month, year].some(Number.isNaN)) return null;
    if (year < 100) year += 2000;
    const date = new Date(year, month, day);
    if (isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return date;
}

function normalizeRoleName(name) {
    return String(name || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function roleNameMatchesManagementRole(name) {
    const n = normalizeRoleName(name);
    if (!n) return false;
    if (MANAGEMENT_ROLES.has(n)) return true;

    // Compare a punctuation/emoji-free form so Discord Unicode presentation
    // differences cannot prevent an authorized management role from matching.
    const compact = n
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');

    return new Set([
        'president',
        'vicepresident',
        'theexecutive',
        'thekicker',
        'thepartyjockey',
        'clubadmin',
        'clubrep',
        'clubrepresentative'
    ]).has(compact);
}

async function isManagementAuthorized(interaction) {
    // Management access is role-based. Authorized TUFC management roles may
    // use management tools from any channel/thread; the old management-thread
    // restriction caused valid managers to be rejected outside that thread.
    const guild = interaction.guild;
    if (!guild) return false;

    try {
        // Fetch the actual GuildMember so this does not depend on the shape of
        // interaction.member.roles in Discord's interaction payload.
        const member = await guild.members.fetch(interaction.user.id);
        const memberRoleIds = new Set([...member.roles.cache.keys()].map(String));

        // Resolve role names from the guild's current role cache.
        const roles = guild.roles.cache.size ? guild.roles.cache : await guild.roles.fetch();
        for (const role of roles.values()) {
            if (memberRoleIds.has(String(role.id)) && roleNameMatchesManagementRole(role.name)) return true;
        }
    } catch (error) {
        console.error('Management authorization check failed:', error);
    }
    return false;
}
async function isAdmin(interaction) { return isManagementAuthorized(interaction); }

function modal(customId, title, fields) {
    return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
        ...fields.map(field => new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(field.style || TextInputStyle.Short)
                .setRequired(field.required !== false).setPlaceholder(field.placeholder || '')
        ))
    );
}

function sheetValue(value) {
    // Discord embed field values must be strings. Keep valid 0 values and
    // display blank/null cells as an em dash instead of dropping them.
    return value === null || value === undefined || value === '' ? '—' : String(value);
}

function findMemberRows(rows) {
    const headers = rows[0] || [];
    return rows.slice(1).map((row, i) => {
        const member = { _sheetRow: i + 5 };
        headers.forEach((header, index) => {
            if (header) member[header] = row[index] ?? '';
        });
        return member;
    });
}
function memberEmbed(member) {
    return new EmbedBuilder().setTitle('👤 Member Information').setDescription(`Information for **${member.IGN || 'Unknown'}**`).addFields(
        { name: 'IGN', value: sheetValue(member.IGN), inline: true }, { name: 'Role', value: sheetValue(member.ROLE), inline: true },
        { name: 'Club Tag', value: sheetValue(member['CLUB TAG']), inline: true }, { name: 'STAT', value: sheetValue(member.STAT) },
        { name: 'GP', value: sheetValue(member.GP), inline: true }, { name: 'Status', value: sheetValue(member.STATUS), inline: true },
        { name: 'GP Start Date', value: sheetValue(member['GP START DATE']), inline: true }, { name: 'GP End Date', value: sheetValue(member['GP END DATE']), inline: true },
        { name: 'Remarks', value: sheetValue(member.REMARKS) },
    );
}
function goldPassEmbed(member) {
    return new EmbedBuilder().setTitle('💳 Gold Pass Information').setDescription(`Gold Pass information for **${member.IGN || 'Unknown'}**`).addFields(
        { name: 'IGN', value: sheetValue(member.IGN), inline: true }, { name: 'Gold Pass', value: sheetValue(member.GP === '' || member.GP == null ? 'NO' : member.GP), inline: true },
        { name: 'Start Date', value: sheetValue(member['GP START DATE']), inline: true }, { name: 'End Date', value: sheetValue(member['GP END DATE']), inline: true },
    );
}
async function lookupMember(ign) {
    const rows = await getMembers();
    return findMemberRows(rows).find(m => String(m.IGN || '').trim().toLowerCase() === ign.trim().toLowerCase());
}
async function lookupMemberByDiscordMember(discordMember) {
    const rows = await getMembers();
    const names = [discordMember.nickname, discordMember.user.username, discordMember.user.globalName].filter(Boolean).map(v => String(v).trim().toLowerCase());
    return findMemberRows(rows).find(m => names.includes(String(m.IGN || '').trim().toLowerCase()));
}

async function showMemberMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('👥 Member Management').setDescription('Choose a member action.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_member_lookup').setLabel('Look Up').setEmoji('🔎').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_member_change').setLabel('Change IGN').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_member_role').setLabel('Change Role').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_member_stats').setLabel('Stats Changed').setEmoji('📊').setStyle(ButtonStyle.Success),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_member_add').setLabel('Add Member').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tufc_member_delete').setLabel('Delete Member').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showAdminMenu(interaction) {
    if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can access Admin tools.', ephemeral: true });
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('🛠️ Admin Management').setDescription('Discord-only administrative tools.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_admin_discord_role').setLabel('Change Discord Role').setEmoji('🏷️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showGoldPassMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('💳 Gold Pass Management').setDescription('Look up, add/update, or remove a Gold Pass.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_gp_lookup').setLabel('Look Up').setEmoji('🔎').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_gp_set').setLabel('Add / Update').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tufc_gp_remove').setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showTimerMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('⏱️ EC Party Drop Timers').setDescription('Set a countdown for the person dropping the EC item. When it reaches zero, TUFCBOT posts the drop notification in this channel.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_timer_dog').setLabel('Dog Star').setEmoji('🐶').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_cat').setLabel('Cat Cafe').setEmoji('🐱').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_pizza').setLabel('Pizza Pop Art').setEmoji('🍕').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_list').setLabel('Active Timers').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
        )
    ]});
}
async function showLBHMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('📣 LBH Call').setDescription('Choose the bar level to call @LBH hitters.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_lbh_2').setLabel('@LBH 2.0 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_15').setLabel('@LBH 1.5 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_1').setLabel('@LBH 1.0 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_05').setLabel('@LBH 0.5 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_lbh_ppotd').setLabel('@LBH PPOTD').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_lbh_potd').setLabel('@LBH POTD').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_lbh_done').setLabel('Party Finished').setEmoji('✅').setStyle(ButtonStyle.Success),
        )
    ]});
}

function buildHubEmbed() {
    const state = loadState();
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🦆 TUFCBOT • Member Hub')
        .setDescription('Your PIMD tools and club management in one place.\nUse the buttons below to open a tool.')
        .addFields({ name: '🏹 Today\'s Parties', value: `**POTD:** ${state?.potd || 'Not found yet'}\n**PPOTD:** ${state?.ppotd || 'Not found yet'}` })
        .setFooter({ text: 'TUFCBOT Member Hub • Party in my Dorm' });
}

function buildHubRows() {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tufc_hub_member').setLabel('Members').setEmoji('👥').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tufc_hub_goldpass').setLabel('Gold Passes').setEmoji('💳').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tufc_hub_timers').setLabel('EC Party Timers').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tufc_hub_lbh').setLabel('LBH Call').setEmoji('📣').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tufc_hub_potd').setLabel('POTD Lookup').setEmoji('🎯').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tufc_hub_announcement').setLabel('Announcement').setEmoji('📢').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tufc_hub_admin').setLabel('Admin').setEmoji('🛠️').setStyle(ButtonStyle.Danger),
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tufc_hub_dorm_upgrade').setLabel('New Dorm Tower Upgrade Calculator').setEmoji('🏢').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tufc_hub_link_discord').setLabel('Link Discord').setEmoji('🔗').setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2, row3];
}
function buildHubPayload() { return { embeds: [buildHubEmbed()], components: buildHubRows() }; }

function sheetValue(value) {
    // Discord embed field values must be strings. Keep valid 0 values and
    // display blank/null cells as an em dash instead of dropping them.
    return value === null || value === undefined || value === '' ? '—' : String(value);
}

function findMemberRows(rows) {
    const headers = rows[0] || [];
    return rows.slice(1).map((row, i) => {
        const member = { _sheetRow: i + 5 };
        headers.forEach((header, index) => {
            if (header) member[header] = row[index] ?? '';
        });
        return member;
    });
}
function memberEmbed(member) {
    return new EmbedBuilder().setTitle('👤 Member Information').setDescription(`Information for **${member.IGN || 'Unknown'}**`).addFields(
        { name: 'IGN', value: sheetValue(member.IGN), inline: true }, { name: 'Role', value: sheetValue(member.ROLE), inline: true },
        { name: 'Club Tag', value: sheetValue(member['CLUB TAG']), inline: true }, { name: 'STAT', value: sheetValue(member.STAT) },
        { name: 'GP', value: sheetValue(member.GP), inline: true }, { name: 'Status', value: sheetValue(member.STATUS), inline: true },
        { name: 'GP Start Date', value: sheetValue(member['GP START DATE']), inline: true }, { name: 'GP End Date', value: sheetValue(member['GP END DATE']), inline: true },
        { name: 'Remarks', value: sheetValue(member.REMARKS) },
    );
}
function goldPassEmbed(member) {
    return new EmbedBuilder().setTitle('💳 Gold Pass Information').setDescription(`Gold Pass information for **${member.IGN || 'Unknown'}**`).addFields(
        { name: 'IGN', value: sheetValue(member.IGN), inline: true }, { name: 'Gold Pass', value: sheetValue(member.GP === '' || member.GP == null ? 'NO' : member.GP), inline: true },
        { name: 'Start Date', value: sheetValue(member['GP START DATE']), inline: true }, { name: 'End Date', value: sheetValue(member['GP END DATE']), inline: true },
    );
}
async function lookupMember(ign) {
    const rows = await getMembers();
    return findMemberRows(rows).find(m => String(m.IGN || '').trim().toLowerCase() === ign.trim().toLowerCase());
}
async function lookupMemberByDiscordMember(discordMember) {
    const rows = await getMembers();
    const names = [discordMember.nickname, discordMember.user.username, discordMember.user.globalName].filter(Boolean).map(v => String(v).trim().toLowerCase());
    return findMemberRows(rows).find(m => names.includes(String(m.IGN || '').trim().toLowerCase()));
}

async function showMemberMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('👥 Member Management').setDescription('Choose a member action.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_member_lookup').setLabel('Look Up').setEmoji('🔎').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_member_change').setLabel('Change IGN').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_member_role').setLabel('Change Role').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_member_stats').setLabel('Stats Changed').setEmoji('📊').setStyle(ButtonStyle.Success),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_member_add').setLabel('Add Member').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tufc_member_delete').setLabel('Delete Member').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showAdminMenu(interaction) {
    if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can access Admin tools.', ephemeral: true });
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('🛠️ Admin Management').setDescription('Discord-only administrative tools.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_admin_discord_role').setLabel('Change Discord Role').setEmoji('🏷️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showGoldPassMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('💳 Gold Pass Management').setDescription('Look up, add/update, or remove a Gold Pass.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_gp_lookup').setLabel('Look Up').setEmoji('🔎').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_gp_set').setLabel('Add / Update').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tufc_gp_remove').setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        )
    ]});
}
async function showTimerMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('⏱️ EC Party Drop Timers').setDescription('Set a countdown for the person dropping the EC item. When it reaches zero, TUFCBOT posts the drop notification in this channel.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_timer_dog').setLabel('Dog Star').setEmoji('🐶').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_cat').setLabel('Cat Cafe').setEmoji('🐱').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_pizza').setLabel('Pizza Pop Art').setEmoji('🍕').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_timer_list').setLabel('Active Timers').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
        )
    ]});
}
async function showLBHMenu(interaction) {
    return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('📣 LBH Call').setDescription('Choose the bar level to call @LBH hitters.')], components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_lbh_2').setLabel('@LBH 2.0 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_15').setLabel('@LBH 1.5 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_1').setLabel('@LBH 1.0 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tufc_lbh_05').setLabel('@LBH 0.5 Bar').setEmoji('📣').setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tufc_lbh_ppotd').setLabel('@LBH PPOTD').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_lbh_potd').setLabel('@LBH POTD').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tufc_lbh_done').setLabel('Party Finished').setEmoji('✅').setStyle(ButtonStyle.Success),
        )
    ]});
}

async function handleHubButton(interaction, client) {
    if (!interaction.isButton()) return false;
    const id = interaction.customId;
    if (!id.startsWith('tufc_')) return false;

    if (id === 'tufc_hub_member') { await showMemberMenu(interaction); return true; }
    if (id === 'tufc_hub_announcement') {
        if (!(await isManagementAuthorized(interaction))) {
            await interaction.reply({ content: '❌ Only authorized TUFC management roles can create announcements.', flags: 64 });
            return true;
        }
        await interaction.showModal(getAnnouncementModal());
        return true;
    }
    if (id === 'tufc_hub_admin') { await showAdminMenu(interaction); return true; }
    if (id === 'tufc_admin_discord_role') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', ephemeral: true });
        return interaction.reply({ flags: 64, content: '👤 Select the specific Discord member whose Discord role you want to change.', components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('tufc_admin_discord_role_select').setPlaceholder('Select Discord member').setMinValues(1).setMaxValues(1))] });
    }
    if (id === 'tufc_hub_link_discord') {
        return interaction.showModal(modal('tufc_modal_link_discord', 'Link Discord', [
            { id: 'ign', label: 'Your TUFC IGN', placeholder: 'Enter your exact IGN from Google Sheets', required: true },
        ]));
    }
    if (id === 'tufc_member_role') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can change member roles.', flags: 64 });
        return interaction.showModal(modal('tufc_modal_member_role_lookup', 'Change Member Role', [
            { id: 'ign', label: 'Member IGN', placeholder: 'Enter the exact IGN from Google Sheets', required: true },
        ]));
    }
    if (id === 'tufc_member_stats') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can change member stats.', ephemeral: true });
        return interaction.showModal(modal('tufc_modal_member_stats', 'Change Member Stats', [
            { id: 'ign', label: 'Member IGN', placeholder: 'Member IGN' },
            { id: 'stats', label: 'Combined Stats', placeholder: 'Example: 750 or 1.25' },
            { id: 'unit', label: 'Unit (MCS or BCS)', placeholder: 'MCS or BCS' },
        ]));
    }
    if (id === 'tufc_hub_goldpass') { await showGoldPassMenu(interaction); return true; }
    if (id === 'tufc_hub_timers') { await showTimerMenu(interaction); return true; }
    if (id === 'tufc_hub_lbh') { await showLBHMenu(interaction); return true; }

    if (id === 'tufc_hub_potd') {
        await interaction.deferReply({ flags: 64 });
        try {
            const result = await checkPOTD(client, { announce: false }); const state = result.state || loadState();
            const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎯 POTD Lookup').addFields(
                { name: '🎉 POTD', value: state.potd || 'Not found yet', inline: true },
                { name: '💎 PPOTD', value: state.ppotd || 'Not found yet', inline: true },
                { name: 'Status', value: result.ok ? '🟢 Checked' : '🔴 Check failed', inline: true },
            );
            if (result.page?.url) embed.setURL(result.page.url);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) { console.error(error); await interaction.editReply('❌ I could not check the POTD right now.'); }
        return true;
    }
    if (id === 'tufc_dorm_refresh') {
        await interaction.showModal(modal('tufc_modal_dorm_upgrade', 'New Dorm Tower Upgrade Calculator', [
            { id: 'stats', label: 'Current Stats (S)', placeholder: 'Current stats', required: true },
            { id: 'cash', label: 'Cash (C)', placeholder: 'Example: 2.5T or 850B', required: true },
            { id: 'dorms', label: 'Opened Dorms (D)', placeholder: 'Example: 20', required: true },
        ]));
        return true;
    }

    if (id === 'tufc_hub_dorm_upgrade') {
        await interaction.showModal(modal('tufc_modal_dorm_upgrade', 'New Dorm Tower Upgrade Calculator', [
            { id: 'stats', label: 'Current Stats (S)', placeholder: 'Current stats', required: true },
            { id: 'cash', label: 'Cash (C)', placeholder: 'Example: 2.5T or 850B', required: true },
            { id: 'dorms', label: 'Opened Dorms (D)', placeholder: 'Example: 20', required: true },
        ]));
        return true;
    }

    const memberModalMap = {
        tufc_member_lookup: modal('tufc_modal_member_lookup', 'Member Lookup', [{ id: 'ign', label: 'Member IGN', placeholder: 'Enter the current IGN' }]),
        tufc_member_add: modal('tufc_modal_member_add', 'Add Member', [{ id: 'ign', label: 'Member IGN', placeholder: 'New member IGN' }]),
        tufc_member_delete: modal('tufc_modal_member_delete', 'Delete Member', [{ id: 'ign', label: 'Member IGN', placeholder: 'IGN to remove' }]),
    };
    if (id === 'tufc_member_change') {
        if (!(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can change member details.', flags: 64 }); return true; }
        return interaction.showModal(modal('tufc_modal_member_change_lookup', 'Change Member IGN', [
            { id: 'ign', label: 'Current Member IGN', placeholder: 'Enter the exact IGN from Google Sheets', required: true },
        ]));
    }
    if (id === 'tufc_member_tag') {
        if (!(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can change member details.', flags: 64 }); return true; }
        await interaction.reply({ flags: 64, content: '👤 Select the Discord member to update.', components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId('tufc_member_select_tag').setPlaceholder('Select Discord member').setMinValues(1).setMaxValues(1)
        )]});
        return true;
    }
    if (memberModalMap[id]) {
        if (id !== 'tufc_member_lookup' && !(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can change the member list.', ephemeral: true }); return true; }
        await interaction.showModal(memberModalMap[id]); return true;
    }
    if (id.startsWith('tufc_member_change_sheet_continue:')) {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can do this.', flags: 64 });
        const oldIgn = decodeURIComponent(id.slice('tufc_member_change_sheet_continue:'.length));
        await interaction.showModal(modal(`tufc_modal_member_change_sheet:${encodeURIComponent(oldIgn)}`, 'Change Member IGN', [
            { id: 'new_ign', label: 'New IGN', placeholder: 'Enter the new IGN', required: true },
        ]));
        return true;
    }

    if (id === 'tufc_member_sheet_select_change') {
        if (!(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can do this.', flags: 64 }); return true; }
        const oldIgn = interaction.values[0];
        const member = await lookupMember(oldIgn);
        if (!member) return interaction.reply({ flags: 64, content: `❌ **${oldIgn}** could not be found in Google Sheets.` });
        await interaction.showModal(modal(`tufc_modal_member_change_sheet:${encodeURIComponent(oldIgn)}`, 'Change Member IGN', [
            { id: 'new_ign', label: 'New IGN', placeholder: 'Enter the new IGN' },
        ]));
        return true;
    }

    if (id === 'tufc_member_select_change' || id === 'tufc_member_select_tag') {
        if (!(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can do this.', ephemeral: true }); return true; }
        const uid = interaction.values[0];
        const isTag = id === 'tufc_member_select_tag';
        await interaction.showModal(modal(`${isTag ? 'tufc_modal_member_tag' : 'tufc_modal_member_change'}:${uid}`, isTag ? 'Change Member Tag' : 'Change Member IGN', isTag ? [
            { id: 'ign', label: 'Member IGN', placeholder: 'Current IGN in Google Sheets' },
            { id: 'old_tag', label: 'Current Discord Role/Tag', placeholder: 'Current role name' },
            { id: 'new_tag', label: 'New Discord Role/Tag', placeholder: 'New role name' },
        ] : [
            { id: 'old_ign', label: 'Current IGN in Google Sheets', placeholder: 'Current IGN' },
            { id: 'new_ign', label: 'New IGN', placeholder: 'New IGN' },
        ]));
        return true;
    }

    const gpModalMap = {
        tufc_gp_lookup: modal('tufc_modal_gp_lookup', 'Gold Pass Lookup', [{ id: 'ign', label: 'Member IGN', placeholder: 'Enter the IGN' }]),
        tufc_gp_set: modal('tufc_modal_gp_set', 'Add / Update Gold Pass', [{ id: 'ign', label: 'Member IGN', placeholder: 'Member IGN' }, { id: 'start', label: 'Start Date', placeholder: 'DD/MM/YYYY' }, { id: 'end', label: 'End Date', placeholder: 'DD/MM/YYYY' }]),
        tufc_gp_remove: modal('tufc_modal_gp_remove', 'Remove Gold Pass', [{ id: 'ign', label: 'Member IGN', placeholder: 'Member IGN' }]),
    };
    if (gpModalMap[id]) {
        if (id !== 'tufc_gp_lookup' && !(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can change Gold Passes.', ephemeral: true }); return true; }
        await interaction.showModal(gpModalMap[id]); return true;
    }

    if (id.startsWith('tufc_timer_')) {
        const partyKey = id.replace('tufc_timer_', '');
        if (PARTY_INFO[partyKey]) {
            await interaction.showModal(modal(`tufc_modal_timer:${partyKey}`, `${PARTY_INFO[partyKey].emoji} ${PARTY_INFO[partyKey].name}`, [
                { id: 'duration', label: 'Countdown', placeholder: 'Examples: 10m, 1h 30m, 01:30:00' },
                { id: 'ign', label: 'EC Dropper IGN', placeholder: 'IGN of the person dropping the EC item' },
            ]));
            return true;
        }
        if (partyKey === 'list') {
            const active = listTimers(interaction.channelId);
            if (!active.length) { await interaction.reply({ flags: 64, content: '⏳ No active EC timers in this channel.' }); return true; }
            const text = active.map(t => `${t.emoji} **${t.partyName}** — **${t.ign}** — <t:${Math.floor(t.endAt / 1000)}:R> (ends <t:${Math.floor(t.endAt / 1000)}:T>)`).join('\n');
            await interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('⏳ Active EC Timers').setDescription(text)] }); return true;
        }
    }

    const lbhLabels = { tufc_lbh_2: '2.0 Bar', tufc_lbh_15: '1.5 Bar', tufc_lbh_1: '1.0 Bar', tufc_lbh_05: '0.5 Bar', tufc_lbh_ppotd: 'PPOTD', tufc_lbh_potd: 'POTD', tufc_lbh_done: 'Party is finished' };
    if (lbhLabels[id]) {
        const role = interaction.guild?.roles.cache.get(process.env.LBH_ROLE_ID) || interaction.guild?.roles.cache.find(r => r.name.toLowerCase() === 'lbh');
        if (!role) { await interaction.reply({ flags: 64, content: '❌ I could not find the **LBH** role. Set `LBH_ROLE_ID` in your .env or name the role exactly `LBH`.' }); return true; }
        let message;
        if (id === 'tufc_lbh_done') {
            message = `✅ ${role} — **Party is finished!**`;
        } else if (id === 'tufc_lbh_ppotd') {
            message = `${role} **PPOTD is up.** Reminder to hit the party.`;
        } else if (id === 'tufc_lbh_potd') {
            message = `${role} **POTD is up.** Reminder to hit the party.`;
        } else {
            message = `📣 ${role} — **LBH call: ${lbhLabels[id]}!** Hitters, please get ready.`;
        }

        const targetChannelId = process.env.LBH_CHANNEL_ID || '1433477225251995740';
        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || typeof targetChannel.send !== 'function') {
            await interaction.reply({ flags: 64, content: `❌ I could not access the LBH destination channel/thread (${targetChannelId}). Check the channel ID and bot permissions.` });
            return true;
        }
        await targetChannel.send({ content: message, allowedMentions: { roles: [role.id] } });
        await interaction.reply({ flags: 64, content: `✅ LBH call posted in <#${targetChannelId}>.` });
        return true;
    }

    if (id === 'tufc_admin_discord_role_select') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', ephemeral: true });
        const uid = interaction.values[0];
        const member = await interaction.guild.members.fetch(uid);
        const roles = member.roles.cache.filter(r => !r.managed && r.id !== interaction.guild.id && r.editable).sort((a,b) => b.position - a.position);
        if (!roles.size) return interaction.reply({ flags: 64, content: '❌ This member has no Discord roles that the bot can change.' });
        const options = [...roles.values()].slice(0, 25).map(r => ({ label: r.name.slice(0, 100), value: r.id }));
        return interaction.reply({ flags: 64, content: `👤 **${member.displayName}** selected. Choose the current Discord role you want to replace.`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tufc_admin_discord_current:${uid}`).setPlaceholder('Select current Discord role').addOptions(options))] });
    }
    if (id.startsWith('tufc_admin_discord_current:')) {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', ephemeral: true });
        const uid = id.split(':')[1], currentRoleId = interaction.values[0];
        const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id && !r.managed && r.editable && r.id !== currentRoleId).sort((a,b) => b.position - a.position);
        if (!roles.size) return interaction.reply({ flags: 64, content: '❌ No other editable Discord roles are available.' });
        const options = [...roles.values()].slice(0, 25).map(r => ({ label: r.name.slice(0, 100), value: r.id }));
        const current = interaction.guild.roles.cache.get(currentRoleId);
        return interaction.reply({ flags: 64, content: `🏷️ Current role: **${current?.name || 'Unknown'}**. Choose the new Discord role.
📄 Google Sheets will not be changed.`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tufc_admin_discord_new:${uid}:${currentRoleId}`).setPlaceholder('Select new Discord role').addOptions(options))] });
    }
    if (id.startsWith('tufc_admin_discord_new:')) {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', ephemeral: true });
        const [, uid, currentRoleId] = id.split(':'), newRoleId = interaction.values[0];
        const member = await interaction.guild.members.fetch(uid);
        const currentRole = interaction.guild.roles.cache.get(currentRoleId), newRole = interaction.guild.roles.cache.get(newRoleId);
        if (!currentRole || !newRole || currentRole.managed || newRole.managed) return interaction.reply({ flags: 64, content: '❌ One of the selected roles cannot be changed.' });
        if (!currentRole.editable || !newRole.editable) return interaction.reply({ flags: 64, content: '❌ I cannot modify one of those roles. Make sure my bot role is above them.' });
        if (!member.roles.cache.has(currentRole.id)) return interaction.reply({ flags: 64, content: '❌ The member no longer has the selected current role.' });
        await member.roles.remove(currentRole, 'TUFCBOT admin Discord role change');
        await member.roles.add(newRole, 'TUFCBOT admin Discord role change');
        return interaction.reply({ flags: 64, content: `✅ Discord role changed for **${member.displayName}**: **${currentRole.name}** → **${newRole.name}**.
📄 Google Sheets was not changed.` });
    }
    return false;
}

function findDiscordMember(guild, ign) {
    const needle = String(ign).trim().toLowerCase();
    return guild.members.cache.find(m => [m.nickname, m.user.username, m.user.globalName].filter(Boolean).some(v => String(v).trim().toLowerCase() === needle));
}
function compactRoleName(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

const SHEET_ROLE_ALIASES = new Map([
    ['president', 'President 🐉'],
    ['vp', 'Vice-President 『♕』'],
    ['vicepresident', 'Vice-President 『♕』'],
    ['executive', 'The Executive『♗』'],
    ['theexecutive', 'The Executive『♗』'],
    ['exec', 'The Executive『♗』'],
    ['kicker', 'The Kicker 『♖』'],
    ['thekicker', 'The Kicker 『♖』'],
    ['pj', 'The Party Jockey 『♘』'],
    ['partyjockey', 'The Party Jockey 『♘』'],
    ['thepartyjockey', 'The Party Jockey 『♘』'],
    ['clubrep', 'Club Admin 👮🏻‍♂️'],
    ['clubadmin', 'Club Admin 👮🏻‍♂️'],
]);

function findRole(guild, value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (guild.roles.cache.has(raw)) return guild.roles.cache.get(raw);

    const exact = guild.roles.cache.find(r => r.name.trim().toLowerCase() === raw.toLowerCase());
    if (exact) return exact;

    const aliasTarget = SHEET_ROLE_ALIASES.get(compactRoleName(raw));
    if (aliasTarget) {
        const targetCompact = compactRoleName(aliasTarget);
        const mapped = guild.roles.cache.find(r => compactRoleName(r.name) === targetCompact);
        if (mapped) return mapped;
    }

    // Also allow common sheet abbreviations to match the corresponding
    // Discord role even when the sheet stores only PJ/VP/etc.
    const key = compactRoleName(raw);
    return guild.roles.cache.find(r => {
        const roleKey = compactRoleName(r.name);
        for (const [alias, target] of SHEET_ROLE_ALIASES) {
            if (alias === key && roleKey === compactRoleName(target)) return true;
        }
        return false;
    }) || null;
}

async function handleHubSelectMenu(interaction, client) {
    if (!interaction.isAnySelectMenu()) return false;
    const id = interaction.customId;
    if (!id.startsWith('tufc_')) return false;

    if (id.startsWith('tufc_announcement_channel:')) {
        if (!(await isManagementAuthorized(interaction))) return interaction.reply({ flags: 64, content: '❌ Only authorized TUFC management roles can post announcements.' });
        cleanupAnnouncementDrafts();

        const draftId = id.slice('tufc_announcement_channel:'.length);
        const draft = pendingAnnouncements.get(draftId);
        if (!draft) return interaction.reply({ flags: 64, content: '❌ This announcement draft has expired. Please start the announcement again.' });
        if (draft.userId !== interaction.user.id) return interaction.reply({ flags: 64, content: '❌ Only the person who created this announcement can post it.' });
        if (draft.guildId !== interaction.guildId) return interaction.reply({ flags: 64, content: '❌ This announcement draft belongs to a different server.' });

        const channelId = interaction.values[0];
        if (!ANNOUNCEMENT_CHANNEL_IDS.includes(channelId)) {
            return interaction.reply({ flags: 64, content: '❌ That channel is not approved for TUFC announcements.' });
        }
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            return interaction.reply({ flags: 64, content: '❌ Please choose a normal text or announcement channel.' });
        }

        const permissions = channel.permissionsFor(interaction.guild.members.me);
        if (!permissions?.has('ViewChannel') || !permissions?.has('SendMessages') || !permissions?.has('EmbedLinks')) {
            return interaction.reply({ flags: 64, content: `❌ I cannot post an announcement in <#${channelId}>. I need **View Channel**, **Send Messages**, and **Embed Links** there.` });
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📢 ${draft.title}`)
            .setDescription(draft.message)
            .setFooter({ text: `TUFCBOT • Posted by ${interaction.member?.displayName || interaction.user.username}` })
            .setTimestamp();

        // A direct upload takes precedence over a URL if both were supplied.
        const image = draft.uploadedImageUrl || draft.imageUrl;
        if (image) embed.setImage(image);

        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        pendingAnnouncements.delete(draftId);
        return interaction.update({ content: `✅ Announcement sent to <#${channelId}>.`, components: [] });
    }

    if (id === 'tufc_member_sheet_select_change') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can do this.', flags: 64 });
        const oldIgn = interaction.values[0];
        const member = await lookupMember(oldIgn);
        if (!member) return interaction.reply({ flags: 64, content: `❌ **${oldIgn}** could not be found in Google Sheets.` });
        await interaction.showModal(modal(`tufc_modal_member_change_sheet:${encodeURIComponent(oldIgn)}`, 'Change Member IGN', [
            { id: 'new_ign', label: 'New IGN', placeholder: 'Enter the new IGN' },
        ]));
        return true;
    }

    if (id === 'tufc_member_role_sheet_select') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', flags: 64 });
        const ign = interaction.values[0];
        const sheetMember = await lookupMember(ign);
        if (!sheetMember?.IGN) return interaction.reply({ flags: 64, content: `❌ **${ign}** could not be found in Google Sheets.` });

        const rows = await getMembers();
        const roleNames = [...new Set(findMemberRows(rows).map(m => String(m.ROLE || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (!roleNames.length) return interaction.reply({ flags: 64, content: '❌ No roles were found in the Google Sheets ROLE column.' });
        if (roleNames.length > 25) return interaction.reply({ flags: 64, content: `❌ There are ${roleNames.length} Google Sheets roles. Discord menus support up to 25 choices.` });

        return interaction.reply({
            flags: 64,
            content: `👤 **${sheetMember.IGN}** selected from Google Sheets.\n🏷️ Choose the new Google Sheets role for this member.`,
            components: [new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`tufc_member_role_pick:${encodeURIComponent(sheetMember.IGN)}`)
                    .setPlaceholder('Select Google Sheets role')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(roleNames.map(name => ({ label: name.slice(0, 100), value: name.slice(0, 100) })))
            )]
        });
    }

    if (id.startsWith('tufc_member_role_pick:')) {
        // Google Sheets + Discord role sync can exceed Discord's 3-second
        // interaction window. Acknowledge immediately, then edit the reply.
        await interaction.deferReply({ flags: 64 });
        if (!(await isAdmin(interaction))) return interaction.editReply('❌ Only authorized management roles can use this tool.');
        const ign = decodeURIComponent(id.slice('tufc_member_role_pick:'.length));
        const next = interaction.values[0];
        const sheetMember = await lookupMember(ign);
        if (!sheetMember?.IGN) return interaction.editReply({ content: `❌ **${ign}** could not be found in Google Sheets.` });

        const newRole = findRole(interaction.guild, next);
        if (!newRole) return interaction.editReply({ content: `❌ Google Sheets role **${next}** does not have a matching Discord role.` });

        let discordStatus = '⚠️ The Google Sheets role was updated, but no matching Discord member was found for this IGN.';

try {
    const needle = String(sheetMember.IGN || '').trim().toLowerCase();

    // Check cached members first.
    // Do NOT fetch the entire guild member list — that can cause GuildMembersTimeout.
    let member = findDiscordMember(interaction.guild, sheetMember.IGN);

    // If the member isn't cached, search Discord only for this IGN.
    if (!member && needle) {
        const matches = await interaction.guild.members.search({
            query: String(sheetMember.IGN).trim(),
            limit: 10
        });

        member = matches.find(m =>
            [m.nickname, m.user?.username, m.user?.globalName, m.displayName]
                .filter(Boolean)
                .some(v => String(v).trim().toLowerCase() === needle)
        ) || null;
    }

    if (member) {
        const oldRole = sheetMember.ROLE
            ? findRole(interaction.guild, sheetMember.ROLE)
            : null;

        if (
            oldRole &&
            oldRole.id !== newRole.id &&
            oldRole.editable &&
            member.roles.cache.has(oldRole.id)
        ) {
            await member.roles.remove(
                oldRole,
                'TUFCBOT member role change'
            );
        }

        if (!newRole.editable) {
            throw new Error(
                `Bot cannot manage Discord role: ${newRole.name}`
            );
        }

        if (!member.roles.cache.has(newRole.id)) {
            await member.roles.add(
                newRole,
                'TUFCBOT member role change'
            );
        }

        discordStatus =
            `✅ Discord role synced for **${member.displayName}**.`;
    }
} catch (error) {
    console.error('Member role Discord sync failed:', error);
    discordStatus =
        `⚠️ Google Sheets will be updated, but Discord role sync failed: ${error.message}`;
}
        const sheet = await updateMemberRole(sheetMember.IGN, next);
        if (!sheet.success) return interaction.editReply({ content: `❌ Discord role was processed, but **${sheetMember.IGN}** could not be updated in Google Sheets.` });
        return interaction.editReply({ content: `✅ **${sheetMember.IGN}** role changed from **${sheetMember.ROLE || '—'}** to **${next}**.\n📄 Google Sheets ROLE updated.\n${discordStatus}` });
    }

    if (id === 'tufc_admin_discord_role_select') {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', flags: 64 });
        const uid = interaction.values[0];
        const member = await interaction.guild.members.fetch(uid);
        const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id && !r.managed);
        if (!roles.size) return interaction.reply({ flags: 64, content: '❌ That member has no editable Discord roles.' });
        const options = [...roles.values()].slice(0, 25).map(r => ({ label: r.name.slice(0,100), value: r.id }));
        return interaction.reply({ flags: 64, content: '🏷️ Choose the current Discord role to replace.', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tufc_admin_discord_current:${uid}`).setPlaceholder('Select current role').addOptions(options))] });
    }
    if (id.startsWith('tufc_admin_discord_current:')) {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', flags: 64 });
        const uid = id.split(':')[1], currentRoleId = interaction.values[0];
        const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id && !r.managed && r.editable && r.id !== currentRoleId);
        if (!roles.size) return interaction.reply({ flags: 64, content: '❌ No other editable Discord roles are available.' });
        const options = [...roles.values()].slice(0, 25).map(r => ({ label: r.name.slice(0,100), value: r.id }));
        const current = interaction.guild.roles.cache.get(currentRoleId);
        return interaction.reply({ flags: 64, content: `🏷️ Current role: **${current?.name || 'Unknown'}**. Choose the new Discord role.\n📄 Google Sheets will not be changed.`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`tufc_admin_discord_new:${uid}:${currentRoleId}`).setPlaceholder('Select new Discord role').addOptions(options))] });
    }
    if (id.startsWith('tufc_admin_discord_new:')) {
        if (!(await isAdmin(interaction))) return interaction.reply({ content: '❌ Only authorized management roles can use this tool.', flags: 64 });
        const [, uid, currentRoleId] = id.split(':'), newRoleId = interaction.values[0];
        const member = await interaction.guild.members.fetch(uid);
        const currentRole = interaction.guild.roles.cache.get(currentRoleId), newRole = interaction.guild.roles.cache.get(newRoleId);
        if (!currentRole || !newRole || currentRole.managed || newRole.managed) return interaction.reply({ flags: 64, content: '❌ One of the selected roles cannot be changed.' });
        if (!currentRole.editable || !newRole.editable) return interaction.reply({ flags: 64, content: '❌ I cannot modify one of those roles. Make sure my bot role is above them.' });
        if (!member.roles.cache.has(currentRole.id)) return interaction.reply({ flags: 64, content: '❌ The member no longer has the selected current role.' });
        await member.roles.remove(currentRole, 'TUFCBOT admin Discord role change');
        await member.roles.add(newRole, 'TUFCBOT admin Discord role change');
        return interaction.reply({ flags: 64, content: `✅ Discord role changed for **${member.displayName}**: **${currentRole.name}** → **${newRole.name}**.\n📄 Google Sheets was not changed.` });
    }
    return false;
}

async function handleHubModal(interaction, client) {
    if (!interaction.isModalSubmit()) return false;
    const id = interaction.customId;
    if (!id.startsWith('tufc_modal_')) return false;

    if (id === 'tufc_modal_member_lookup') {
        await interaction.deferReply({ flags: 64 });
        try { const member = await lookupMember(interaction.fields.getTextInputValue('ign')); return interaction.editReply(member ? { embeds: [memberEmbed(member)] } : '❌ Member not found.'); }
        catch (e) { console.error(e); return interaction.editReply('❌ Google Sheets lookup failed.'); }
    }
    if (id === 'tufc_modal_gp_lookup') {
        const member = await lookupMember(interaction.fields.getTextInputValue('ign'));
        return interaction.reply({ flags: 64, embeds: [member ? goldPassEmbed(member) : new EmbedBuilder().setTitle('💳 Gold Pass').setDescription('❌ Member not found.')] });
    }

    if (id === 'tufc_modal_member_role_lookup') {
        await interaction.deferReply({ flags: 64 });
        try {
            const ign = interaction.fields.getTextInputValue('ign').trim();
            const sheetMember = await lookupMember(ign);
            if (!sheetMember?.IGN) {
                return interaction.editReply(`❌ **${ign}** could not be found in Google Sheets.`);
            }
            const rows = await getMembers();
            const roleNames = [...new Set(
                findMemberRows(rows)
                    .map(m => String(m.ROLE || '').trim())
                    .filter(Boolean)
            )].sort((a, b) => a.localeCompare(b));
            if (!roleNames.length) return interaction.editReply('❌ No roles were found in the Google Sheets ROLE column.');
            if (roleNames.length > 25) return interaction.editReply(`❌ There are ${roleNames.length} Google Sheets roles. Discord menus support up to 25 choices.`);
            return interaction.editReply({
                content: `👤 **${sheetMember.IGN}** selected from Google Sheets.\n🏷️ Choose the new Google Sheets role for this member.`,
                components: [new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`tufc_member_role_pick:${encodeURIComponent(sheetMember.IGN)}`)
                        .setPlaceholder('Select Google Sheets role')
                        .setMinValues(1)
                        .setMaxValues(1)
                        .addOptions(roleNames.map(name => ({ label: name.slice(0, 100), value: name.slice(0, 100) })))
                )]
            });
        } catch (error) {
            console.error('[MEMBER ROLE LOOKUP] Failed:', error);
            return interaction.editReply('❌ I could not look up that member. Check the Railway logs for details.');
        }
    }
    // Delete Member must acknowledge the Discord modal before the role check.
    // The management-role lookup calls Discord and can occasionally exceed
    // Discord's 3-second interaction window.
    if (id === 'tufc_modal_member_delete') {
        await interaction.deferReply({ flags: 64 });
        if (!(await isAdmin(interaction))) {
            return interaction.editReply('❌ Only authorized management roles can perform this action.');
        }
        try {
            const ign = interaction.fields.getTextInputValue('ign').trim();
            if (!ign) return interaction.editReply('❌ Member IGN cannot be empty.');

            const r = await deleteMember(ign);
            if (!r.success && r.reason === 'MEMBER_NOT_FOUND') {
                return interaction.editReply(`❌ **${ign}** was not found in Google Sheets.`);
            }
            return interaction.editReply(`🗑️ **${ign}** was permanently removed from Google Sheets — row ${r.row} deleted.`);
        } catch (error) {
            console.error(`[DELETE MEMBER] Failed for IGN "${interaction.fields.getTextInputValue('ign').trim()}"`, error);
            const detail = error?.message ? String(error.message) : 'Unknown error';
            return interaction.editReply(`❌ I couldn't delete the member.\n\n**Reason:** ${detail.slice(0, 1500)}`);
        }
    }

    if (id === 'tufc_modal_link_discord') {
        await interaction.deferReply({ flags: 64 });
        try {
            const ign = interaction.fields.getTextInputValue('ign').trim();
            if (!ign) return interaction.editReply('❌ IGN cannot be empty.');

            const sheetMember = await lookupMember(ign);
            if (!sheetMember?.IGN) {
                return interaction.editReply(`❌ **${ign}** could not be found in Google Sheets.`);
            }

            const discordId = String(interaction.user.id);
            const existingForIgn = String(sheetMember['DISCORD ID'] || '').trim();
            if (existingForIgn && existingForIgn !== discordId) {
                return interaction.editReply('❌ This IGN is already linked to a different Discord account. Please contact TUFC management if this needs to be changed.');
            }

            const rows = await getMembers();
            const headers = rows[0] || [];
            const ignIndex = headers.findIndex(h => String(h || '').trim().toLowerCase() === 'ign');
            const discordIndex = headers.findIndex(h => ['discord id', 'discord user id', 'discord_id'].includes(String(h || '').trim().toLowerCase()));
            if (ignIndex === -1 || discordIndex === -1) {
                return interaction.editReply('❌ The Google Sheet is missing the **DISCORD ID** column. Please check the member sheet header.');
            }

            const alreadyLinkedElsewhere = rows.slice(1).some(row =>
                String(row[discordIndex] || '').trim() === discordId &&
                String(row[ignIndex] || '').trim().toLowerCase() !== String(sheetMember.IGN).trim().toLowerCase()
            );
            if (alreadyLinkedElsewhere) {
                return interaction.editReply('❌ Your Discord account is already linked to a different TUFC IGN. Please contact TUFC management if your IGN has changed.');
            }

            const result = await updateMemberDiscordId(sheetMember.IGN, discordId);
            if (!result.success) return interaction.editReply(`❌ **${ign}** could not be linked.`);
            return interaction.editReply(`✅ **${sheetMember.IGN}** is now linked to your Discord account.\n🔗 Discord ID saved successfully.`);
        } catch (error) {
            console.error('[LINK DISCORD] Failed:', error);
            const detail = error?.message ? String(error.message) : 'Unknown error';
            return interaction.editReply(`❌ I couldn't link your Discord account.\n\n**Reason:** ${detail.slice(0, 1200)}`);
        }
    }

    if (!(await isAdmin(interaction))) { await interaction.reply({ content: '❌ Only authorized management roles can perform this action.', ephemeral: true }); return true; }

    try {
        if (id === 'tufc_modal_announcement') {
            cleanupAnnouncementDrafts();

            const title = interaction.fields.getTextInputValue('title').trim();
            const message = interaction.fields.getTextInputValue('message').trim();
            const imageUrl = interaction.fields.getTextInputValue('image_url').trim();

            if (!title || !message) return interaction.reply({ flags: 64, content: '❌ Announcement title and message are required.' });
            if (title.length > 256) return interaction.reply({ flags: 64, content: '❌ Announcement title is too long (maximum 256 characters).' });
            if (message.length > 4096) return interaction.reply({ flags: 64, content: '❌ Announcement message is too long (maximum 4096 characters).' });
            if (imageUrl && !isValidHttpUrl(imageUrl)) return interaction.reply({ flags: 64, content: '❌ The image URL must be a valid http:// or https:// URL.' });

            const draftId = createAnnouncementDraftId(interaction.user.id);
            pendingAnnouncements.set(draftId, {
                createdAt: Date.now(),
                userId: interaction.user.id,
                guildId: interaction.guildId,
                title,
                message,
                imageUrl: imageUrl || null,
                uploadedImageUrl: null,
            });

            const imageNote = imageUrl
                ? '🔗 Image URL attached.'
                : '📝 Text-only announcement.';

            return interaction.reply({
                flags: 64,
                content: `📢 **Announcement ready.**\n${imageNote}\n\nChoose the channel to post it. Approved TUFC announcement channels are <#${ANNOUNCEMENT_CHANNEL_IDS[0]}> and <#${ANNOUNCEMENT_CHANNEL_IDS[1]}>.`,
                components: [announcementChannelPicker(draftId)]
            });
        }

        if (id.startsWith('tufc_modal_member_change_sheet:')) {
            const oldIgn = decodeURIComponent(id.slice('tufc_modal_member_change_sheet:'.length));
            const newIgn = interaction.fields.getTextInputValue('new_ign').trim();
            await interaction.deferReply({ flags: 64 });
            if (!newIgn) return interaction.editReply('❌ New IGN cannot be empty.');
            const r = await updateMemberIGN(oldIgn, newIgn);
            if (!r.success) return interaction.editReply(`❌ **${oldIgn}** was not found in Google Sheets.`);
            return interaction.editReply(`✅ IGN changed from **${oldIgn}** to **${newIgn}** in Google Sheets.`);
        }
        if (id.startsWith('tufc_modal_member_change:')) {
            const uid = id.split(':')[1], oldIgn = interaction.fields.getTextInputValue('old_ign').trim(), newIgn = interaction.fields.getTextInputValue('new_ign').trim();
            const r = await updateMemberIGN(oldIgn, newIgn); if (!r.success) return interaction.reply({ flags: 64, content: `❌ **${oldIgn}** was not found in Google Sheets.` });
            let status = '⚠️ Google Sheets changed, but Discord nickname could not be changed.';
            try { const m = await interaction.guild.members.fetch(uid); await m.setNickname(newIgn, `TUFCBOT IGN change: ${oldIgn} -> ${newIgn}`); status = `✅ Discord nickname changed for ${m.user.tag}.`; } catch (e) { console.error(e); }
            return interaction.reply({ flags: 64, content: `✅ IGN changed from **${oldIgn}** to **${newIgn}** in Google Sheets.\n${status}` });
        }
        if (id === 'tufc_modal_gp_set') {
            const ign = interaction.fields.getTextInputValue('ign').trim();
            const startInput = interaction.fields.getTextInputValue('start').trim();
            const endInput = interaction.fields.getTextInputValue('end').trim();
            const normalizeInputDate = (value) => {
                const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
                if (!match) return null;
                let year = Number(match[3]);
                if (year < 100) year += 2000;
                const day = Number(match[1]), month = Number(match[2]);
                const date = new Date(year, month - 1, day);
                if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
                return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
            };
            const start = normalizeInputDate(startInput);
            const end = normalizeInputDate(endInput);
            if (!start || !end) return interaction.reply({ flags: 64, content: '❌ Dates must use **DD/MM/YY** (for example `01/09/26`).' });
            if (parseDate(end) < parseDate(start)) return interaction.reply({ flags: 64, content: '❌ The Gold Pass end date cannot be before the start date.' });
            const r = await updateGoldPass(ign, start, end);
            if (!r.success) return interaction.reply({ flags: 64, content: `❌ **${ign}** was not found.` });
            return interaction.reply({ flags: 64, content: `✅ Gold Pass updated for **${ign}** — **${start}** to **${end}**.` });
        }
        if (id === 'tufc_modal_gp_remove') { const ign = interaction.fields.getTextInputValue('ign').trim(); const r = await removeGoldPass(ign); return interaction.reply({ flags: 64, content: r.success ? `🗑️ Gold Pass removed for **${ign}**.` : `❌ **${ign}** was not found.` }); }
        if (id.startsWith('tufc_modal_timer:')) {
            const partyKey = id.split(':')[1], durationInput = interaction.fields.getTextInputValue('duration'), ign = interaction.fields.getTextInputValue('ign').trim();
            const duration = parseDuration(durationInput); if (!duration) return interaction.reply({ flags: 64, content: '❌ Invalid countdown. Use `10m`, `1h 30m`, `01:30`, or `01:30:00`.' });
            const timer = await createTimer({ partyKey, durationMs: duration, ign, channel: interaction.channel });
            return interaction.reply({ flags: 64, content: `✅ ${timer.emoji} **${timer.partyName}** timer set for **${timer.ign}**.\n⏱️ **${formatDuration(duration)}** remaining — drop at <t:${Math.floor(timer.endAt / 1000)}:F> (<t:${Math.floor(timer.endAt / 1000)}:R>).` });
        }
        if (id === 'tufc_modal_dorm_upgrade') {
            const result = solveDormUpgrade({
                stats: interaction.fields.getTextInputValue('stats').trim(),
                cash: interaction.fields.getTextInputValue('cash').trim(),
                dorms: interaction.fields.getTextInputValue('dorms').trim(),
            });
            if (result.error) return interaction.reply({ flags: 64, content: `❌ ${result.error}` });
            const output = [
                `Current Stats: ${result.stats} Cash: ${result.cash} Dorms: ${result.dorms}`,
                '',
                '**MAXIMUM STATS ACHIEVABLE**',
                '',
                `T6 3★: ${result.a} T7 3★: ${result.b} T8 3★: ${result.c} T9 Base: ${result.d} T9 3★: ${result.e}`,
                '',
                `Total Cost: ${result.totalCostDisplay} Cash Left: ${result.cashLeftDisplay} Stats Increase: ${result.statsIncreaseDisplay}`,
                '',
                `Best Combination: ${result.bestCombination}`,
                '',
                'Use **[REFRESH]** below to enter new S/C/D and recalculate.',
                '',
                'Goodluck',
            ].join('\n');
            return interaction.reply({ flags: 64, content: output, components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tufc_dorm_refresh').setLabel('REFRESH').setStyle(ButtonStyle.Primary)
            )] });
        }
        if (id === 'tufc_modal_member_stats') {
            const ign = interaction.fields.getTextInputValue('ign').trim(), stats = interaction.fields.getTextInputValue('stats').trim(), unit = interaction.fields.getTextInputValue('unit').trim().toUpperCase();
            if (!['MCS', 'BCS'].includes(unit) || !/^\d+(?:\.\d+)?$/.test(stats)) return interaction.reply({ flags: 64, content: '❌ Enter a numeric value and use **MCS** or **BCS**.' });
            const r = await updateMemberStats(ign, stats, unit); if (!r.success) return interaction.reply({ flags: 64, content: `❌ **${ign}** was not found in Google Sheets.` });
            return interaction.reply({ flags: 64, content: `✅ Stats updated for **${ign}** to **${stats} ${unit}** in Google Sheets.` });
        }
    } catch (error) {
        console.error('Member Hub modal error:', error);
        if (interaction.replied || interaction.deferred) return interaction.editReply('❌ The operation failed. Check the bot console for details.');
        return interaction.reply({ flags: 64, content: '❌ The operation failed. Check the bot console for details.' });
    }
    return true;
}

module.exports = { buildHubEmbed, buildHubRows, buildHubPayload, handleHubButton, handleHubModal, handleHubSelectMenu, isManagementAuthorized };
