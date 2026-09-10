require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { getMembers, updateGoldPass, markGoldPassNotified } = require('./googlesheets');
const { checkPOTD, startPOTDMonitor, loadState, saveState } = require('./potdmonitor');
const {
    buildHubPayload,
    handleHubButton,
    handleHubModal,
    handleHubSelectMenu,
    isManagementAuthorized
} = require('./hub');

const {
    buildPublicHubPayload,
    handlePublicButton,
    handlePublicModal
} = require('./publichub');
const { startTimers } = require('./timers');
const { startEventMonitor } = require('./eventmonitor');
const { startDashboard } = require('./dashboard/server');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Discord server ID
const GUILD_ID = '1362609555900600503';

// TUFCBOT Application ID
const CLIENT_ID = '1545247213800919111';

const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check if TUFCBOT is responding')
        .addRoleOption(option =>
            option
                .setName('role')
                .setDescription('Role to mention with the ping (defaults to Club Admin)')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('member')
        .setDescription('Look up a club member')
        .addStringOption(option =>
            option
                .setName('ign')
                .setDescription("Member's in-game name")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('goldpasses')
        .setDescription('Show members with Gold Passes'),

    new SlashCommandBuilder()
        .setName('goldpass')
        .setDescription('Manage Gold Passes')
        .addSubcommand(subcommand =>
            subcommand
                .setName('check')
                .setDescription("Check a member's Gold Pass")
                .addStringOption(option =>
                    option
                        .setName('ign')
                        .setDescription("Member's in-game name")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Add or update a Gold Pass')
                .addStringOption(option =>
                    option
                        .setName('ign')
                        .setDescription("Member's in-game name")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('start')
                        .setDescription('Start date DD/MM/YYYY')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('end')
                        .setDescription('End date DD/MM/YYYY')
                        .setRequired(true)
                )
        )
        ,

    new SlashCommandBuilder()
        .setName('hub')
        .setDescription('Post the TUFCBOT Member Hub panel (Admin only)'),

    new SlashCommandBuilder()
        .setName('announcement')
        .setDescription('Create and post a curated TUFC announcement')
        .addStringOption(option =>
            option
                .setName('title')
                .setDescription('Announcement title')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('details')
                .setDescription('Announcement details')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Channel where the announcement should be posted')
                .addChannelTypes(0, 5)
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option
                .setName('photo')
                .setDescription('Optional announcement photo')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('publichub')
        .setDescription('Post the TUFC Public Hub'),
        .setName('potd')
        .setDescription('Check and monitor Party in my Dorm Party of the Day')
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription("Show today's POTD and PPOTD status")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('pro')
                .setDescription("Show today's Pro Party of the Day")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('refresh')
                .setDescription('Immediately check the PIMD POTD forum (Admin only)')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('history')
                .setDescription('Show recent POTD and PPOTD results')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Set this channel for automatic POTD announcements (Admin only)')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('mention')
                .setDescription('Set a role to ping when POTD/PPOTD is found (Admin only)')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('Role to mention')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('mentionoff')
                .setDescription('Disable POTD role mentions (Admin only)')
        )
].map(command => command.toJSON());

const rest = new REST({ version: '10' })
    .setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error(error);
    }
})();

client.once('clientReady', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    startDashboard(client);
});


// Convert DD/MM/YYYY into a JavaScript Date
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


// Calculate days remaining
function daysRemaining(endDate) {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    const difference = endDate - today;

    return Math.ceil(difference / (1000 * 60 * 60 * 24));
}


client.on('interactionCreate', async interaction => {
    
    // Public Hub buttons
    if (interaction.customId.startsWith('tufc_public_')) {
        await handlePublicButton(interaction);
        return;
    }
    // Member Hub buttons and forms
    if (interaction.isButton()) {
        try {
            const handled = await handleHubButton(interaction, client);
            if (handled) return;
        } catch (error) {
            console.error('Member Hub button error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ TUFCBOT could not complete that action. Check the bot console for details.', flags: 64 }).catch(() => {});
            }
            return;
        }
    }

    if (interaction.isAnySelectMenu()) {
        try {
            const handled = await handleHubSelectMenu(interaction, client);
            if (handled) return;
        } catch (error) {
            console.error('Member Hub select menu error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ TUFCBOT could not complete that selection. Check the bot console for details.', flags: 64 }).catch(() => {});
            }
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('tufc_public_')) {
    await handlePublicModal(interaction);
    return;
}
        try {
            const handled = await handleHubModal(interaction, client);
            if (handled) return;
        } catch (error) {
            console.error('Member Hub modal error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ TUFCBOT could not complete that action. Check the bot console for details.', flags: 64 }).catch(() => {});
            }
            return;
        }
    }

    if (!interaction.isChatInputCommand()) return;


    // =========================
    // /announcement
    // =========================

    if (interaction.commandName === 'announcement') {
        if (!(await isManagementAuthorized(interaction))) {
            return await interaction.reply({
                content: '❌ You need one of the TUFC management roles to use this tool.',
                flags: 64
            });
        }

        const title = interaction.options.getString('title', true).trim();
        const details = interaction.options.getString('details', true).trim();
        const channel = interaction.options.getChannel('channel', true);
        const photo = interaction.options.getAttachment('photo');

        if (!title || !details) {
            return await interaction.reply({ content: '❌ Title and details are required.', flags: 64 });
        }
        if (title.length > 256) {
            return await interaction.reply({ content: '❌ The title is too long (maximum 256 characters).', flags: 64 });
        }
        if (details.length > 4096) {
            return await interaction.reply({ content: '❌ The details are too long (maximum 4096 characters).', flags: 64 });
        }
        if (!channel.isTextBased?.() || ![0, 5].includes(channel.type)) {
            return await interaction.reply({ content: '❌ Please choose a normal text or announcement channel.', flags: 64 });
        }
        if (photo && !(String(photo.contentType || '').toLowerCase().startsWith('image/'))) {
            return await interaction.reply({ content: '❌ The uploaded file must be an image.', flags: 64 });
        }

        const permissions = channel.permissionsFor(interaction.guild.members.me);
        if (!permissions?.has('ViewChannel') || !permissions?.has('SendMessages') || !permissions?.has('EmbedLinks')) {
            return await interaction.reply({
                content: `❌ I cannot post an announcement in <#${channel.id}>. I need **View Channel**, **Send Messages**, and **Embed Links** there.`,
                flags: 64
            });
        }

        await interaction.deferReply({ flags: 64 });
        try {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`📢 ${title}`)
                .setDescription(details)
                .setFooter({ text: `TUFCBOT • Posted by ${interaction.member?.displayName || interaction.user.username}` })
                .setTimestamp();

            if (photo) embed.setImage(photo.url);

            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            return await interaction.editReply(`✅ Announcement sent to <#${channel.id}>.`);
        } catch (error) {
            console.error('Announcement command error:', error);
            return await interaction.editReply('❌ I could not post the announcement. Check that the bot can access and send messages in the selected channel.');
        }
    }

    // =========================
    // /hub
    // =========================

    if (interaction.commandName === 'hub') {
        try {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({
                    content: '❌ You need one of the TUFC management roles to use this tool.',
                    flags: 64
                });
            }

            // Acknowledge the interaction immediately, then edit it with the panel.
            // This prevents Discord's \"application did not respond\" message if
            // embed/button construction takes longer than expected or throws.
            await interaction.deferReply();
            await interaction.editReply(await buildHubPayload());
        } catch (error) {
            console.error('Member Hub command error:', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply('❌ I could not create the Member Hub. Check the bot console for the error.');
            } else {
                await interaction.reply({ content: '❌ I could not create the Member Hub.', flags: 64 });
            }
        }
        return;
    }


    // =========================
    // /ping
    // =========================

    if (interaction.commandName === 'ping') {
        let role = interaction.options.getRole('role');

        // If no role was supplied, default to the exact TUFC management role
        // requested for bot notifications.
        if (!role && interaction.guild) {
            role = interaction.guild.roles.cache.find(r => r.name === 'Club Admin 👮🏻‍♂️') || null;
        }

        if (role) {
            await interaction.reply({
                content: `🏓 Pong! <@&${role.id}>`,
                allowedMentions: { roles: [role.id] }
            });
        } else {
            await interaction.reply('🏓 Pong!');
        }
        return;
    }


    // =========================
    // /member
    // =========================

    if (interaction.commandName === 'member') {

        const ignSearch = interaction.options.getString('ign');

        await interaction.deferReply();

        try {

            const rows = await getMembers();

            if (rows.length === 0) {
                return await interaction.editReply(
                    '❌ No member data was found in Google Sheets.'
                );
            }

            const headers = rows[0];

            const members = rows.slice(1).map(row => {

                const member = {};

                headers.forEach((header, index) => {
                    if (header) {
                        member[header] = row[index] || '';
                    }
                });

                return member;
            });


            const member = members.find(
                m =>
                    String(m['IGN'] || '').trim().toLowerCase() ===
                    ignSearch.trim().toLowerCase()
            );


            if (!member) {
                return await interaction.editReply(
                    `❌ No member found with the IGN **${ignSearch}**.`
                );
            }


            const embed = new EmbedBuilder()
                .setTitle('👤 Member Information')
                .addFields(
                    {
                        name: 'IGN',
                        value: member['IGN'] || '—',
                        inline: true
                    },
                    {
                        name: 'Role',
                        value: member['ROLE'] || '—',
                        inline: true
                    },
                    {
                        name: 'Club Tag',
                        value: member['CLUB TAG'] || '—',
                        inline: true
                    },
                    {
                        name: 'STAT',
                        value: member['STAT'] || '—',
                        inline: false
                    },
                    {
                        name: 'GP',
                        value: member['GP'] || '—',
                        inline: true
                    },
                    {
                        name: 'Status',
                        value: member['STATUS'] || '—',
                        inline: true
                    },
                    {
                        name: 'GP Start Date',
                        value: member['GP START DATE'] || '—',
                        inline: true
                    },
                    {
                        name: 'GP End Date',
                        value: member['GP END DATE'] || '—',
                        inline: true
                    },
                    {
                        name: 'Remarks',
                        value: member['REMARKS'] || '—',
                        inline: false
                    },
                    {
                        name: 'Other Remarks',
                        value: member['OTHER REMARKS'] || '—',
                        inline: false
                    },
                    {
                        name: 'Banned Pips',
                        value: member['BANNED PIPS'] || '—',
                        inline: false
                    }
                );

            await interaction.editReply({
                embeds: [embed]
            });

        } catch (error) {

            console.error('Member lookup error:', error);

            await interaction.editReply(
                '❌ There was a problem reading the Google Sheet.'
            );
        }

        return;
    }


    // =========================
    // /goldpasses
    // =========================

    if (interaction.commandName === 'goldpasses') {

        await interaction.deferReply();

        try {

            const rows = await getMembers();

            if (rows.length === 0) {
                return await interaction.editReply(
                    '❌ No member data was found in Google Sheets.'
                );
            }


            const headers = rows[0];

            const members = rows.slice(1).map(row => {

                const member = {};

                headers.forEach((header, index) => {

                    if (header) {
                        member[header] = row[index] || '';
                    }

                });

                return member;
            });


            // Only members with GP information
            const goldPassMembers = members.filter(member => {

                const gp = String(member['GP'] || '')
                    .trim()
                    .toLowerCase();

                const startDate = member['GP START DATE'];
                const endDate = member['GP END DATE'];

                return (
                    gp !== '' &&
                    startDate &&
                    endDate
                );
            });


            if (goldPassMembers.length === 0) {

                return await interaction.editReply(
                    '🟡 No Gold Pass members found.'
                );
            }


            const embed = new EmbedBuilder()
                .setTitle('🟡 TUFC Gold Passes')
                .setDescription(
                    `Currently tracking **${goldPassMembers.length}** Gold Pass member(s).`
                );


            for (const member of goldPassMembers) {

                const endDate = parseDate(member['GP END DATE']);

                let status = '🟢 Active';

                if (endDate) {

                    const remaining = daysRemaining(endDate);

                    if (remaining < 0) {
                        status = `🔴 Expired ${Math.abs(remaining)} day(s) ago`;
                    } else if (remaining === 0) {
                        status = '🔴 Expires today';
                    } else if (remaining <= 3) {
                        status = `🟡 Expires in ${remaining} day(s)`;
                    } else {
                        status = `🟢 ${remaining} day(s) remaining`;
                    }
                }


                embed.addFields({
                    name: `${member['IGN'] || 'Unknown'} — ${status}`,
                    value:
                        `**GP:** ${member['GP'] || '—'}\n` +
                        `**Start:** ${member['GP START DATE'] || '—'}\n` +
                        `**End:** ${member['GP END DATE'] || '—'}`,
                    inline: false
                });
            }


            await interaction.editReply({
                embeds: [embed]
            });

        } catch (error) {

            console.error('Gold Pass lookup error:', error);

            await interaction.editReply(
                '❌ There was a problem reading the Gold Pass data.'
            );
        }

        return;
    }


    // =========================
    // /potd
    // =========================

    if (interaction.commandName === 'potd') {
        const subcommand = interaction.options.getSubcommand();
        const state = loadState();

        if (subcommand === 'channel') {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({ content: '❌ You need one of the TUFC management roles to use this tool.', flags: 64 });
            }

            state.notificationChannelId = interaction.channelId;
            saveState(state);

            return await interaction.reply(`✅ POTD automatic announcements will now be sent in <#${interaction.channelId}>.`);
        }

        if (subcommand === 'mention') {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({ content: '❌ You need one of the TUFC management roles to use this tool.', flags: 64 });
            }

            const role = interaction.options.getRole('role');
            state.mentionRoleId = role.id;
            saveState(state);

            return await interaction.reply(`✅ POTD announcements will now mention **${role.name}**.`);
        }

        if (subcommand === 'mentionoff') {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({ content: '❌ You need one of the TUFC management roles to use this tool.', flags: 64 });
            }

            state.mentionRoleId = null;
            saveState(state);

            return await interaction.reply('✅ POTD role mentions have been disabled.');
        }

        if (subcommand === 'refresh') {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({ content: '❌ You need one of the TUFC management roles to use this tool.', flags: 64 });
            }

            await interaction.deferReply();
            const result = await checkPOTD(client);

            if (!result.ok) {
                return await interaction.editReply('❌ I could not read the PIMD POTD forum right now. Check the bot console for details.');
            }

            const latest = result.state;
            return await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('🔄 POTD Monitor Refreshed')
                    .addFields(
                        { name: '🎉 POTD', value: latest.potd || 'Not found yet', inline: true },
                        { name: '💎 PPOTD', value: latest.ppotd || 'Not found yet', inline: true },
                        { name: 'Forum Page', value: String(result.page.page), inline: true }
                    )
                    .setFooter({ text: 'TUFCBOT • PIMD POTD Monitor' })]
            });
        }

        if (subcommand === 'history') {
            const history = Array.isArray(state.history) ? state.history.slice(0, 10) : [];

            if (history.length === 0) {
                return await interaction.reply('📭 No POTD history has been recorded yet.');
            }

            const description = history.map((item, index) =>
                `${index + 1}. **${item.party}** — ${item.type} — ${item.cycle}`
            ).join('\n');

            return await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('📜 TUFC POTD History')
                    .setDescription(description)
                    .setFooter({ text: 'TUFCBOT • PIMD POTD Monitor' })]
            });
        }

        await interaction.deferReply();
        const refreshed = await checkPOTD(client, { announce: false });
        const current = refreshed.state || loadState();

        if (subcommand === 'pro') {
            const party = current.ppotd;
            return await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('💎 Pro Party of the Day')
                    .setDescription(party ? `**${party}**` : 'The PPOTD has not been identified yet.')
                    .addFields({ name: 'Status', value: party ? '🟢 Found' : '🟡 Searching', inline: true })
                    .setFooter({ text: 'TUFCBOT • PIMD POTD Monitor' })]
            });
        }

        return await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('🎉 Party of the Day Status')
                .addFields(
                    { name: '🎉 POTD', value: current.potd || '🟡 Not found yet', inline: true },
                    { name: '💎 PPOTD', value: current.ppotd || '🟡 Not found yet', inline: true },
                    { name: 'Announcement Channel', value: current.notificationChannelId ? `<#${current.notificationChannelId}>` : '⚠️ Not configured', inline: false },
                    { name: 'Mention Role', value: current.mentionRoleId ? `<@&${current.mentionRoleId}>` : 'None', inline: false }
                )
                .setFooter({ text: 'TUFCBOT • PIMD POTD Monitor' })]
        });
    }

    // =========================
    // /goldpass
    // =========================

    if (interaction.commandName === 'goldpass') {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'check') {
            const ignSearch = interaction.options.getString('ign');
            await interaction.deferReply();

            try {
                const rows = await getMembers();
                if (rows.length === 0) {
                    return await interaction.editReply('❌ No member data was found in Google Sheets.');
                }

                const headers = rows[0];
                const members = rows.slice(1).map(row => {
                    const member = {};
                    headers.forEach((header, index) => {
                        if (header) member[header] = row[index] || '';
                    });
                    return member;
                });

                const member = members.find(m =>
                    String(m['IGN'] || '').trim().toLowerCase() === ignSearch.trim().toLowerCase()
                );

                if (!member) {
                    return await interaction.editReply(`❌ No member found with the IGN **${ignSearch}**.`);
                }

                const gp = String(member['GP'] || '').trim().toLowerCase();
                const startDate = member['GP START DATE'];
                const endDate = member['GP END DATE'];

                if (!gp || !startDate || !endDate) {
                    return await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setTitle('🟡 Gold Pass')
                            .setDescription(`**${member['IGN']}** does not currently have a Gold Pass recorded.`)
                            .addFields({ name: 'Gold Pass', value: '❌ Not Active', inline: true })]
                    });
                }

                const endDateObject = parseDate(endDate);
                let status = '🟢 Active';
                let remainingText = 'Unknown';

                if (endDateObject) {
                    const remaining = daysRemaining(endDateObject);
                    if (remaining < 0) {
                        status = '🔴 Expired';
                        remainingText = `Expired ${Math.abs(remaining)} day(s) ago`;
                    } else if (remaining === 0) {
                        status = '🔴 Expires today';
                        remainingText = 'Expires today';
                    } else if (remaining <= 3) {
                        status = '🟡 Expiring soon';
                        remainingText = `${remaining} day(s) remaining`;
                    } else {
                        remainingText = `${remaining} day(s) remaining`;
                    }
                }

                const embed = new EmbedBuilder()
                    .setTitle('🟡 Gold Pass Information')
                    .setDescription(`Gold Pass information for **${member['IGN']}**`)
                    .addFields(
                        { name: 'IGN', value: member['IGN'] || '—', inline: true },
                        { name: 'Gold Pass', value: member['GP'] || '—', inline: true },
                        { name: 'Status', value: status, inline: true },
                        { name: 'Start Date', value: startDate || '—', inline: true },
                        { name: 'End Date', value: endDate || '—', inline: true },
                        { name: 'Remaining', value: remainingText, inline: true }
                    );

                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Gold Pass check error:', error);
                await interaction.editReply('❌ There was a problem reading the Gold Pass data.');
            }
            return;
        }

        if (subcommand === 'set') {
            if (!(await isManagementAuthorized(interaction))) {
                return await interaction.reply({
                    content: '❌ You need one of the TUFC management roles to use this tool.',
                    flags: 64
                });
            }

            const ign = interaction.options.getString('ign');
            const start = interaction.options.getString('start');
            const end = interaction.options.getString('end');
            const startDate = parseDate(start);
            const endDate = parseDate(end);

            if (!startDate || !endDate) {
                return await interaction.reply({
                    content: '❌ Invalid date format. Please use **DD/MM/YYYY**.',
                    flags: 64
                });
            }

            if (endDate < startDate) {
                return await interaction.reply({
                    content: '❌ The Gold Pass end date cannot be before the start date.',
                    flags: 64
                });
            }

            await interaction.deferReply({ flags: 64 });

            try {
                const result = await updateGoldPass(ign, start, end);

                if (!result.success && result.reason === 'MEMBER_NOT_FOUND') {
                    return await interaction.editReply(`❌ No member found with the IGN **${ign}**.`);
                }

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('🟡 Gold Pass Updated')
                        .setDescription(`Gold Pass successfully updated for **${result.ign}**.`)
                        .addFields(
                            { name: 'Gold Pass', value: 'YES', inline: true },
                            { name: 'Start Date', value: result.startDate, inline: true },
                            { name: 'End Date', value: result.endDate, inline: true }
                        )
                        .setFooter({ text: 'TUFCBOT • Google Sheets' })]
                });
            } catch (error) {
                console.error('Gold Pass update error:', error);
                await interaction.editReply('❌ Failed to update the Gold Pass in Google Sheets.');
            }
            return;
        }
    }

});


// =========================
// Gold Pass expiry notifications
// =========================

const GOLD_PASS_NOTIFICATION_CHANNEL_ID = '1545418649450315796';
const GOLD_PASS_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

async function checkGoldPassExpiries() {
    try {
        const channel = await client.channels.fetch(GOLD_PASS_NOTIFICATION_CHANNEL_ID);

        if (!channel || !channel.isTextBased()) {
            console.error('❌ Gold Pass notification channel is invalid or not text-based.');
            return;
        }

        const rows = await getMembers();
        if (rows.length <= 1) return;

        const headers = rows[0];
        const members = rows.slice(1).map((row, index) => ({
            row,
            sheetRow: 5 + index,
        }));

        for (const { row, sheetRow } of members) {
            const member = {};
            headers.forEach((header, index) => {
                if (header) member[header] = row[index] || '';
            });

            const ign = String(member['IGN'] || '').trim();
            const gp = String(member['GP'] || '').trim().toLowerCase();
            const endDateString = String(member['GP END DATE'] || '').trim();
            const notified = String(member['GP 3 DAY NOTIFIED'] || '').trim().toLowerCase();

            if (!ign || !endDateString || !gp) continue;
            if (['no', 'false', '0'].includes(gp)) continue;
            if (['yes', 'true', '1'].includes(notified)) continue;

            const endDate = parseDate(endDateString);
            if (!endDate) continue;

            const remaining = daysRemaining(endDate);

            // Notify once when the pass reaches 3 days remaining or less,
            // but only while it is still active.
            if (remaining <= 3 && remaining > 0) {
                const embed = new EmbedBuilder()
                    .setTitle('🟡 Gold Pass Expiring Soon')
                    .setDescription(`Gold Pass for **${ign}** is expiring soon.`)
                    .addFields(
                        { name: 'IGN', value: ign, inline: true },
                        { name: 'Expires', value: endDateString, inline: true },
                        { name: 'Time Remaining', value: `${remaining} day(s)`, inline: true }
                    )
                    .setFooter({ text: 'TUFCBOT • Gold Pass Notifications' });

                await channel.send({ embeds: [embed] });
                await markGoldPassNotified(sheetRow);

                console.log(`🟡 Gold Pass notification sent for ${ign} (${remaining} day(s) remaining).`);
            }
        }
    } catch (error) {
        console.error('Gold Pass notification check failed:', error);
    }
}

client.once('clientReady', async () => {
    console.log('🟡 Starting Gold Pass expiry checker...');
    await checkGoldPassExpiries();
    setInterval(checkGoldPassExpiries, GOLD_PASS_CHECK_INTERVAL);

    startPOTDMonitor(client);
    startTimers(client);
    startEventMonitor(client);
});


client.login(process.env.DISCORD_TOKEN);
