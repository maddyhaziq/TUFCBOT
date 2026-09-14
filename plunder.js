function parsePimdNumber(value) {
    if (value === null || value === undefined) return null;

    let input = String(value)
        .trim()
        .toLowerCase()
        .replace(/,/g, '')
        .replace(/\s+/g, '');

    if (!input) return null;

    let multiplier = 1;

    if (input.endsWith('k')) {
        multiplier = 1e3;
        input = input.slice(0, -1);
    } else if (input.endsWith('m')) {
        multiplier = 1e6;
        input = input.slice(0, -1);
    } else if (input.endsWith('b')) {
        multiplier = 1e9;
        input = input.slice(0, -1);
    } else if (input.endsWith('t')) {
        multiplier = 1e12;
        input = input.slice(0, -1);
    } else if (input.endsWith('q')) {
        multiplier = 1e15;
        input = input.slice(0, -1);
    }

    const number = Number(input);

    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    return number * multiplier;
}

function formatPimdNumber(value) {
    if (!Number.isFinite(value)) return '—';

    const abs = Math.abs(value);

    if (abs >= 1e15) {
        return `${(value / 1e15).toFixed(2).replace(/\.?0+$/, '')}Q`;
    }

    if (abs >= 1e12) {
        return `${(value / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
    }

    if (abs >= 1e9) {
        return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
    }

    if (abs >= 1e6) {
        return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
    }

    if (abs >= 1e3) {
        return `${(value / 1e3).toFixed(2).replace(/\.?0+$/, '')}K`;
    }

    return Math.round(value).toLocaleString();
}

function calculatePlunder({ strength, intelligence, tutorValue = null }) {
    const str = parsePimdNumber(strength);
    const intel = parsePimdNumber(intelligence);

    if (str === null || intel === null) {
        return {
            error: 'Please enter valid Strength and Intelligence values.'
        };
    }

    if (str < 0 || intel < 0) {
        return {
            error: 'Stats cannot be negative.'
        };
    }

    const combinedStats = str + intel;

    // Common PIMD max-plunder baseline:
    // Combined Stats × 15,000
    const targetTutorValue = combinedStats * 15000;

    let currentTutor = null;

    if (tutorValue !== null && tutorValue !== undefined && String(tutorValue).trim() !== '') {
        currentTutor = parsePimdNumber(tutorValue);

        if (currentTutor === null) {
            return {
                error: 'Please enter a valid current tutor value.'
            };
        }
    }

    let status = 'unknown';
    let difference = null;
    let progress = null;

    if (currentTutor !== null) {
        difference = targetTutorValue - currentTutor;
        progress = targetTutorValue > 0
            ? (currentTutor / targetTutorValue) * 100
            : 100;

        if (currentTutor >= targetTutorValue) {
            status = 'reached';
        } else {
            status = 'short';
        }
    }

    return {
        strength: str,
        intelligence: intel,
        combinedStats,
        targetTutorValue,
        currentTutor,
        difference,
        progress,
        status
    };
}

module.exports = {
    parsePimdNumber,
    formatPimdNumber,
    calculatePlunder
};
