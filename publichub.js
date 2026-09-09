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

function normalize(value) { return String(value || '').trim().toLowerCase(); }

function publicAllowed(interaction) {
    const configured = String(process.env.PUBLIC_PIMD_CHANNEL_ID || '').trim();
    if (!configured) return true;
    return interaction.channelId === configured || (interaction.channel?.isThread?.() && interaction.channel.parentId === configured);
}

function accessReply(interaction) {
    return interaction.reply({ flags: 64, content: `❌ Please use the public PIMD tools in <#${process.env.PUBLIC_PIMD_CHANNEL_ID}>.` });
}

function buildPublicHubPayload() {
    const state = loadState();
    return {
        embeds: [new EmbedBuilder()
            .setTitle('🌐 TUFCBOT • PIMD Public Hub')
            .setDescription('Independent TUFC PIMD database and public utilities.\nNo TUFC management access is required.')
            .addFields(
                { name: '🎯 POTD', value: state?.potd ? `**${state.potd}**` : 'Not found yet', inline: true },
                { name: '💎 PPOTD', value: state?.ppotd ? `**${state.ppotd}**` : 'Not found yet', inline: true },
                { name: '🗃️ Database', value: 'Items • Furniture • Boxes • Avatars • Parties • Prices', inline: false },
            )
            .setFooter({ text: 'TUFCBOT • Independent PIMD Database' })],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tufc_public_potd').setLabel('POTD Lookup').setEmoji('🎯').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('tufc_public_price').setLabel('Price Check').setEmoji('💰').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('tufc_public_item').setLabel('Item Database').setEmoji('🗃️').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tufc_public_assistant').setLabel('PIMD Assistant').setEmoji('🤖').setStyle(ButtonStyle.Primary),
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
    const ids = ['tufc_public_potd', 'tufc_public_price', 'tufc_public_item', 'tufc_public_assistant'];
    if (!ids.includes(interaction.customId)) return false;
    if (!publicAllowed(interaction)) { await accessReply(interaction); return true; }

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
