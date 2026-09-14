// TUFCBOT — PIMD Public Chat Mirror

const PIMD_API_BASE = 'https://api.partyinmydorm.com';
const PIMD_CHAT_PATH = '/game/poll/chat/';

const DISCORD_CHANNELS = {
    CAMPUS_EUROASIAN: '1548939281597333666',
    CAMPUS_US: '1548939449034088539',
    EXCHANGE_EUROASIAN: '1548940035192131684',
    EXCHANGE_US: '1548939821408456724',
};

const PIMD_REGIONS = {
    CAMPUS_EUROASIAN: 0,
    CAMPUS_US: 1,
    EXCHANGE_EUROASIAN: 10,
    EXCHANGE_US: 11,
};

function getDiscordChannelId(region) {
    switch (Number(region)) {
        case PIMD_REGIONS.CAMPUS_EUROASIAN:
            return DISCORD_CHANNELS.CAMPUS_EUROASIAN;

        case PIMD_REGIONS.CAMPUS_US:
            return DISCORD_CHANNELS.CAMPUS_US;

        case PIMD_REGIONS.EXCHANGE_EUROASIAN:
            return DISCORD_CHANNELS.EXCHANGE_EUROASIAN;

        case PIMD_REGIONS.EXCHANGE_US:
            return DISCORD_CHANNELS.EXCHANGE_US;

        default:
            return null;
    }
}

async function testDiscordChannels(client) {
    console.log('🔎 Testing PIMD chat Discord channels...');

    for (const [name, channelId] of Object.entries(DISCORD_CHANNELS)) {
        const channel = await client.channels
            .fetch(channelId)
            .catch(() => null);

        if (!channel) {
            console.error(
                `❌ ${name}: channel not found (${channelId})`
            );
            continue;
        }

        console.log(
            `✅ ${name}: #${channel.name} (${channelId})`
        );
    }

    console.log('🔎 PIMD chat Discord channel test complete.');
}

function getAccessToken() {
    return (
        process.env.PIMD_ACCESS_TOKEN ||
        ''
    ).trim();
}

async function startPimdChatMirror(client) {
    console.log('🌐 Starting PIMD public chat mirror...');

    if (!getAccessToken()) {
        console.error(
            '❌ PIMD_ACCESS_TOKEN is not configured.'
        );
        return;
    }

    console.log(
        `🔗 PIMD endpoint: ${PIMD_API_BASE}${PIMD_CHAT_PATH}`
    );

    await testDiscordChannels(client);

    console.log('✅ PIMD public chat mirror started.');
}

module.exports = {
    DISCORD_CHANNELS,
    PIMD_REGIONS,
    getDiscordChannelId,
    startPimdChatMirror,
    testDiscordChannels,
};
