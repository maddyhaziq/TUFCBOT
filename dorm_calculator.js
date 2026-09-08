const TIERS = [
    { key: 'a', label: 'T6 3★', costB: 45, stats: 100 },
    { key: 'b', label: 'T7 3★', costB: 128, stats: 256 },
    { key: 'c', label: 'T8 3★', costB: 1100, stats: 520 },
    { key: 'd', label: 'T9 Base', costB: 5900, stats: 580 },
    { key: 'e', label: 'T9 3★', costB: 9125, stats: 820 },
];

function parseCash(input) {
    const raw = String(input || '').trim().toUpperCase().replace(/,/g, '');
    const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(K|M|B|T)?$/);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    const multiplier = { K: 1e-6, M: 1e-3, B: 1, T: 1000 }[match[2] || 'B'];
    return value * multiplier;
}

function formatCashB(valueB) {
    const abs = Math.abs(valueB);
    if (abs >= 1000) return `${trim(valueB / 1000)}T`;
    return `${trim(valueB)}B`;
}

function trim(value) {
    return Number(value.toFixed(3)).toString();
}

function formatStatsHundredths(value) {
    return trim(value / 100);
}

function solveDormUpgrade({ stats, cash, dorms }) {
    const S = String(stats || '').trim();
    const C = parseCash(cash);
    const D = Number.parseInt(String(dorms || '').trim(), 10);

    if (!S) return { error: 'Please enter your current stats in S.' };
    if (C === null) return { error: 'Please enter cash as a number such as 500B or 1.5T.' };
    if (!Number.isInteger(D) || D < 0) return { error: 'Opened dorms must be a whole number of 0 or more.' };

    const baselineCost = 45 * D;
    if (baselineCost > C + 1e-9) {
        return { error: `Your cash cannot fund exactly ${D} towers at the minimum cost.` };
    }

    // Work in whole billions for cost and hundredths for stats, avoiding floating-point
    // comparisons for the optimization itself. For cash entered in smaller units, C is
    // still represented exactly enough for the game's displayed B/T precision.
    const budget = C;
    let best = null;

    // Starting with all towers as T6 3★ means every upgrade has a cost delta and a
    // stats delta. For fixed c/d/e, b is always taken as high as the remaining budget
    // permits because b improves stats while still replacing a T6 tower.
    for (let e = 0; e <= D; e++) {
        const costE = e * 9080;
        if (costE > budget - baselineCost + 1e-9) break;
        for (let d = 0; d <= D - e; d++) {
            const costDE = costE + d * 5855;
            if (costDE > budget - baselineCost + 1e-9) break;
            for (let c = 0; c <= D - e - d; c++) {
                const upgraded = c + d + e;
                const remainingTowers = D - upgraded;
                const extraCost = costDE + c * 1055;
                const cashForB = budget - baselineCost - extraCost;
                if (cashForB < -1e-9) break;

                const b = Math.min(remainingTowers, Math.floor((cashForB + 1e-9) / 83));
                const a = remainingTowers - b;
                const totalCost = baselineCost + a * 0 + b * 83 + c * 1055 + d * 5855 + e * 9080;
                if (totalCost > budget + 1e-7) continue;

                const totalStats = a * 100 + b * 256 + c * 520 + d * 580 + e * 820;
                const cashLeft = budget - totalCost;

                if (!best || totalStats > best.totalStats ||
                    (totalStats === best.totalStats && cashLeft < best.cashLeft - 1e-7)) {
                    best = { a, b, c, d, e, totalCost, cashLeft, totalStats };
                }
            }
        }
    }

    if (!best) return { error: 'No valid combination was found.' };

    return {
        stats: S,
        cash: cash,
        dorms: D,
        ...best,
        totalCostDisplay: formatCashB(best.totalCost),
        cashLeftDisplay: formatCashB(best.cashLeft),
        statsIncreaseDisplay: formatStatsHundredths(best.totalStats),
        bestCombination: `T6 3★ × ${best.a} | T7 3★ × ${best.b} | T8 3★ × ${best.c} | T9 Base × ${best.d} | T9 3★ × ${best.e}`,
    };
}

module.exports = { solveDormUpgrade, parseCash, formatCashB };
