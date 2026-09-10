const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { loadState } = require('./potdmonitor');
const { searchDatabase } = require('./pimd_database');
const { getMembers } = require('./googlesheets');
const { solveDormUpgrade } = require('./dorm_calculator');

function normalize(value) { return String(value || '').trim().toLowerCase(); }

function publicAllowed(interaction) {
    const configured = String(process.env.PUBLIC_PIMD_CHANNEL_ID || '').trim();
    if (!configured) return true;
    return interaction.channelId === configured || (interaction.channel?.isThread?.() && interaction.channel.parentId === configured);
}

function accessReply(interaction) {
    return interaction.reply({ flags: 64, content: `❌ Please use the public PIMD tools in <#${process.env.PUBLIC_PIMD_CHANNEL_ID}>.` });
}

async function buildPublicHubPayload() {
    const state = loadState();

    let totalMembers = 0;
    let activeMembers = 0;

    try {
        const rows = await getMembers();

        if (rows.length > 1) {
            const headers = rows[0].map(h => String(h || '').trim().toUpperCase());

            const ignIndex = headers.indexOf('IGN');
            const statusIndex = headers.indexOf('STATUS');

            const members = rows.slice(1).filter(row => {
                if (ignIndex === -1) return false;
                return String(row[ignIndex] || '').trim() !== '';
            });

            totalMembers = members.length;

            if (statusIndex !== -1) {
                activeMembers = members.filter(row =>
                    String(row[statusIndex] || '').trim().toLowerCase() === 'active'
                ).length;
            }
        }
    } catch (error) {
        console.error('PublicHub member stats error:', error);
    }

    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('🌐 THE UNFILTERED CORNER • PUBLIC HUB')
                .setDescription(
                    'Welcome to **The Unfiltered Corner**.\n\n' +
                    'Come as you are, stay for the chaos.'
                )
                .addFields(
                    {
                        name: '📊 Club Stats',
                        value:
                            `👥 **Total Members:** ${totalMembers}\n` +
                            `🟢 **Active Members:** ${activeMembers}`,
                        inline: false
                    },
                    {
                        name: '🎉 Party of the Day',
                        value:
                            `🎯 **POTD:** ${state?.potd || 'Not found yet'}\n` +
                            `💎 **PPOTD:** ${state?.ppotd || 'Not found yet'}`,
                        inline: false
                    },
                    {
                        name: '🏗️ New Dorm Tower Upgrade',
                        value: 'Use the calculator to find the best tower upgrade combination based on your stats, cash and opened dorms.',
                        inline: false
                    },
                    {
                        name: '🤝 Recruitment',
                        value: 'Interested in joining TUFC?\nClick **Join TUFC** below.',
                        inline: false
                    }
                )
                .setFooter({ text: 'The Unfiltered Corner • Public Hub' })
                .setTimestamp()
        ],

        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('tufc_public_potd')
                    .setLabel('POTD')
                    .setEmoji('🎉')
                    .setStyle(ButtonStyle.Primary),

                new ButtonBuilder()
                    .setCustomId('tufc_public_dorm_upgrade')
                    .setLabel('Dorm Tower Upgrade')
                    .setEmoji('🏗️')
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setLabel('Join TUFC')
                    .setEmoji('🤝')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://discord.gg/SzcT7aq8Uq')
            )
        ]
    };
}

function textModal(id, title, label, placeholder, style = TextInputStyle.Short) {
    return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('query').setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(true)
        )
    );
}

function priceModal() { return textModal('tufc_public_price_modal', '💰 PIMD Price Check', 'Item name', 'Enter the exact or partial item name'); }
function itemModal() { return textModal('tufc_public_item_modal', '🗃️ PIMD Item Database', 'Item name', 'Enter the exact or partial item name'); }
function assistantModal() {
    return new ModalBuilder().setCustomId('tufc_public_assistant_modal').setTitle('🤖 PIMD Assistant').addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('question').setLabel('What do you need help with?').setPlaceholder("Example: what's today's POTD?").setStyle(TextInputStyle.Paragraph).setRequired(true)
        )
    );
}

function sourceFooter(record) {
    const source = record['Source URL'] || record.Source || '';
    return source ? `Source: ${source}` : 'TUFC PIMD Database';
}

function first(results, sheet) { return results.find(r => r.sheet === sheet)?.record || null; }

async function handlePublicButton(interaction) {
    const ids = [
    'tufc_public_potd',
    'tufc_public_price',
    'tufc_public_item',
    'tufc_public_assistant',
    'tufc_public_dorm_upgrade'
];
    if (!ids.includes(interaction.customId)) return false;
    if (!publicAllowed(interaction)) { await accessReply(interaction); return true; }
    if (interaction.customId === 'tufc_public_dorm_upgrade') {
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId('tufc_public_dorm_upgrade_modal')
            .setTitle('🏗️ New Dorm Tower Upgrade Calculator')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('stats')
                        .setLabel('Current Stats (S)')
                        .setPlaceholder('Enter your current stats')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('cash')
                        .setLabel('Cash (C)')
                        .setPlaceholder('Example: 2.5T or 850B')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('dorms')
                        .setLabel('Opened Dorms (D)')
                        .setPlaceholder('Example: 20')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                )
            )
    );

    return true;
}

    if (interaction.customId === 'tufc_public_price') { await interaction.showModal(priceModal()); return true; }
    if (interaction.customId === 'tufc_public_item') { await interaction.showModal(itemModal()); return true; }
    if (interaction.customId === 'tufc_public_assistant') { await interaction.showModal(assistantModal()); return true; }

    const state = loadState();
    await interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('🎯 PIMD Party of the Day').addFields(
        { name: '🎉 POTD', value: state?.potd || 'Not found yet', inline: true },
        { name: '💎 PPOTD', value: state?.ppotd || 'Not found yet', inline: true },
    ).setFooter({ text: 'TUFCBOT • Public PIMD Tools' })] });
    return true;
}

async function handlePublicModal(interaction) {
    if (!interaction.customId.startsWith('tufc_public_')) return false;
    if (!publicAllowed(interaction)) { await accessReply(interaction); return true; }

    if (interaction.customId === 'tufc_public_dorm_upgrade_modal') {
        const stats = interaction.fields.getTextInputValue('stats');
        const cash = interaction.fields.getTextInputValue('cash');
        const dorms = interaction.fields.getTextInputValue('dorms');

        const result = solveDormUpgrade({
            stats,
            cash,
            dorms
        });

        if (result.error) {
            return interaction.reply({
                flags: 64,
                content: `❌ ${result.error}`
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🏗️ New Dorm Tower Upgrade')
            .addFields(
                {
                    name: '📊 Current Stats',
                    value: String(result.stats),
                    inline: true
                },
                {
                    name: '💰 Cash',
                    value: String(result.cash),
                    inline: true
                },
                {
                    name: '🏢 Opened Dorms',
                    value: String(result.dorms),
                    inline: true
                },
                {
                    name: '💵 Total Cost',
                    value: result.totalCostDisplay,
                    inline: true
                },
                {
                    name: '💰 Cash Left',
                    value: result.cashLeftDisplay,
                    inline: true
                },
                {
                    name: '📈 Stats Increase',
                    value: result.statsIncreaseDisplay,
                    inline: true
                },
                {
                    name: '🏆 Best Combination',
                    value: result.bestCombination,
                    inline: false
                }
            )
            .setFooter({
                text: 'TUFCBOT • New Dorm Tower Upgrade Calculator'
            });

        return interaction.reply({
            flags: 64,
            embeds: [embed]
        });
    }
    if (interaction.customId === 'tufc_public_price_modal') {
        const query = interaction.fields.getTextInputValue('query').trim();
        const results = await searchDatabase(query, ['PIMD_PRICES']);
        const price = results[0]?.record;
        if (!price) {
            const itemResults = await searchDatabase(query, ['PIMD_ITEMS', 'PIMD_FURNITURE', 'PIMD_BOXES', 'PIMD_AVATARS']);
            if (!itemResults.length) return interaction.reply({ flags: 64, content: `🔎 **${query}** is not in the TUFC database yet.` });
            return interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle(`💰 Price Check • ${itemResults[0].record.Name}`).setDescription('The item is in the TUFC database, but we do not have a verified price record yet.').setFooter({ text: sourceFooter(itemResults[0].record) })] });
        }
        const embed = new EmbedBuilder().setTitle(`💰 Price Check • ${price.Name}`)
            .setDescription('Community prices can change. Treat this as the latest value recorded in the TUFC database.');
        if (price.Low) embed.addFields({ name: 'Low', value: String(price.Low), inline: true });
        if (price.Typical) embed.addFields({ name: 'Typical', value: String(price.Typical), inline: true });
        if (price.High) embed.addFields({ name: 'High', value: String(price.High), inline: true });
        if (price.Currency) embed.addFields({ name: 'Currency', value: String(price.Currency), inline: true });
        if (price.Confidence) embed.addFields({ name: 'Confidence', value: String(price.Confidence), inline: true });
        if (price.Notes) embed.addFields({ name: 'Notes', value: String(price.Notes), inline: false });
        if (price['Last Verified']) embed.addFields({ name: 'Last Verified', value: String(price['Last Verified']), inline: true });
        embed.setFooter({ text: sourceFooter(price) });
        await interaction.reply({ flags: 64, embeds: [embed] });
        return true;
    }

    if (interaction.customId === 'tufc_public_item_modal') {
        const query = interaction.fields.getTextInputValue('query').trim();
        const results = await searchDatabase(query, ['PIMD_ITEMS', 'PIMD_FURNITURE', 'PIMD_BOXES', 'PIMD_AVATARS', 'PIMD_PARTIES']);
        if (!results.length) return interaction.reply({ flags: 64, content: `🔎 **${query}** is not in the TUFC PIMD database yet.` });
        const { sheet, record } = results[0];
        const embed = new EmbedBuilder().setTitle(`🗃️ PIMD Database • ${record.Name}`).addFields({ name: 'Database', value: sheet.replace('PIMD_', ''), inline: true });
        const fields = [
            ['Category', record.Category], ['Type', record.Type], ['Stats', record.Stats], ['Description', record.Description],
            ['Year/Event', record['Year/Event']], ['Contents', record.Contents], ['Cost/Trade', record['Cost/Trade']],
            ['Series', record.Series], ['Shard Cost', record['Shard Cost']], ['Duration', record.Duration], ['Damage Needed', record['Damage Needed']],
            ['Drops', record.Drops], ['Status', record.Status], ['Notes', record.Notes], ['Last Verified', record['Last Verified']],
        ];
        for (const [name, value] of fields) if (value) embed.addFields({ name, value: String(value), inline: name !== 'Description' && name !== 'Contents' && name !== 'Drops' && name !== 'Notes' });
        if (record['Image URL']) embed.setThumbnail(record['Image URL']);
        embed.setFooter({ text: sourceFooter(record) });
        await interaction.reply({ flags: 64, embeds: [embed] });
        return true;
    }

    if (interaction.customId === 'tufc_public_assistant_modal') {
        const question = normalize(interaction.fields.getTextInputValue('question'));
        const state = loadState();
        if (question.includes('potd') || question.includes('party of the day')) {
            return interaction.reply({ flags: 64, content: `🎯 **POTD:** ${state?.potd || 'Not found yet'}\n💎 **PPOTD:** ${state?.ppotd || 'Not found yet'}` });
        }
        if (question.includes('price') || question.includes('worth') || question.includes('value')) {
            return interaction.reply({ flags: 64, content: '💰 Use **Price Check** and enter the item name. TUFCBOT searches its own PIMD price database.' });
        }
        if (question.includes('item') || question.includes('furniture') || question.includes('box') || question.includes('avatar') || question.includes('party')) {
            return interaction.reply({ flags: 64, content: '🗃️ Use **Item Database** and search the item, furniture, box, avatar or party name.' });
        }
        return interaction.reply({ flags: 64, content: '🤖 I can currently help with **POTD, prices and PIMD database lookups**. Use the buttons in the Public Hub.' });
    }

    return true;
}

module.exports = { buildPublicHubPayload, handlePublicButton, handlePublicModal };
