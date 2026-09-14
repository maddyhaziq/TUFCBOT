// TUFCBOT — PIMD Public Chat Mirror
// Read-only Campus / Exchange mirroring

const DISCORD_CHANNELS = {
    CAMPUS_EUROASIAN: '1548939281597333666',
    CAMPUS_US: '1548939449034088539',
    EXCHANGE_EUROASIAN: '1548940035192131684',
    EXCHANGE_US: '1548939821408456724',
};

// PIMD global chat region IDs
const PIMD_REGIONS = {
    CAMPUS_EUROASIAN: 0,
    CAMPUS_US: 1,
    EXCHANGE_EUROASIAN: 10,
    EXCHANGE_US: 11,
};

function getDiscordChannelId(region) {
    switch (region) {
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

module.exports = {
    DISCORD_CHANNELS,
    PIMD_REGIONS,
    getDiscordChannelId,
};
