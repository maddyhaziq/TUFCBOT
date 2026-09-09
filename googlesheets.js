const { google } = require('googleapis');
require('dotenv').config();

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
let authOptions;

if (serviceAccountJson) {
    try {
        authOptions = {
            credentials: JSON.parse(serviceAccountJson),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        };
    } catch (error) {
        throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
    }
} else {
    authOptions = {
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    };
}

const auth = new google.auth.GoogleAuth(authOptions);

const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = '1tCmkiscg08zPgr94X1w4Og8MYd158Hev8DtKS6QaCy4';
const SHEET_NAME = 'TUFC -MEMBERS';
const DATA_START_ROW = 5;
const DATA_START_COLUMN = 2; // B
const DATA_END_COLUMN = 15; // O

function pad2(value) { return String(value).padStart(2, '0'); }

function formatSheetDate(value) {
    if (value === null || value === undefined || value === '') return '';

    // Google Sheets returns true date cells as serial numbers when using
    // UNFORMATTED_VALUE. Convert them explicitly so the bot always displays
    // DD/MM/YY regardless of the spreadsheet locale.
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = Math.round((value - 25569) * 86400000);
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) {
            return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(-2)}`;
        }
    }

    const text = String(value).trim();
    let match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
    if (match) {
        let year = Number(match[3]);
        if (year < 100) year += 2000;
        return `${pad2(match[1])}/${pad2(match[2])}/${String(year).slice(-2)}`;
    }

    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${pad2(iso[3])}/${pad2(iso[2])}/${String(iso[1]).slice(-2)}`;

    return text;
}

async function getMembers() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SHEET_NAME}'!B4:O`,
            valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const rows = response.data.values || [];
        if (!rows.length) return rows;

        const headers = rows[0];
        const dateIndexes = new Set([
            findHeader(headers, ['GP START DATE', 'GOLD PASS START DATE']),
            findHeader(headers, ['GP END DATE', 'GOLD PASS END DATE']),
        ].filter(index => index >= 0));

        return rows.map((row, rowIndex) => {
            if (rowIndex === 0) return row;
            return row.map((value, index) => dateIndexes.has(index) ? formatSheetDate(value) : value);
        });
    } catch (error) {
        console.error('Google Sheets error:', error.message);
        throw error;
    }
}

function columnToLetter(column) {
    let letter = '';
    while (column > 0) {
        const remainder = (column - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        column = Math.floor((column - 1) / 26);
    }
    return letter;
}

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function findHeader(headers, names) {
    const wanted = names.map(normalize);
    return headers.findIndex(header => wanted.includes(normalize(header)));
}

async function updateGoldPass(ign, startDate, endDate) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');

    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    const gpIndex = findHeader(headers, ['GP', 'GOLD PASS']);
    const gpStartIndex = findHeader(headers, ['GP START DATE', 'GOLD PASS START DATE']);
    const gpEndIndex = findHeader(headers, ['GP END DATE', 'GOLD PASS END DATE']);

    if (ignIndex === -1 || gpIndex === -1 || gpStartIndex === -1 || gpEndIndex === -1) {
        throw new Error('Required Gold Pass columns could not be found.');
    }

    const memberRowIndex = rows.findIndex((row, index) =>
        index > 0 && normalize(row[ignIndex]) === normalize(ign)
    );

    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };

    const sheetRow = DATA_START_ROW + memberRowIndex - 1;
    const gpColumn = columnToLetter(gpIndex + DATA_START_COLUMN);
    const gpStartColumn = columnToLetter(gpStartIndex + DATA_START_COLUMN);
    const gpEndColumn = columnToLetter(gpEndIndex + DATA_START_COLUMN);

    const notificationIndex = findHeader(headers, ['GP 3 DAY NOTIFIED']);
    const data = [
        { range: `'${SHEET_NAME}'!${gpColumn}${sheetRow}`, values: [['YES']] },
        { range: `'${SHEET_NAME}'!${gpStartColumn}${sheetRow}`, values: [[startDate]] },
        { range: `'${SHEET_NAME}'!${gpEndColumn}${sheetRow}`, values: [[endDate]] },
    ];
    if (notificationIndex !== -1) {
        const notificationColumn = columnToLetter(notificationIndex + DATA_START_COLUMN);
        data.push({ range: `'${SHEET_NAME}'!${notificationColumn}${sheetRow}`, values: [['NO']] });
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
    });

    return { success: true, row: sheetRow, ign, startDate, endDate };
}

async function removeGoldPass(ign) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');

    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    const gpIndex = findHeader(headers, ['GP', 'GOLD PASS']);
    const gpStartIndex = findHeader(headers, ['GP START DATE', 'GOLD PASS START DATE']);
    const gpEndIndex = findHeader(headers, ['GP END DATE', 'GOLD PASS END DATE']);
    const notificationIndex = findHeader(headers, ['GP 3 DAY NOTIFIED']);

    if (ignIndex === -1 || gpIndex === -1 || gpStartIndex === -1 || gpEndIndex === -1) {
        throw new Error('Required Gold Pass columns could not be found.');
    }

    const memberRowIndex = rows.findIndex((row, index) =>
        index > 0 && normalize(row[ignIndex]) === normalize(ign)
    );
    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };

    const sheetRow = DATA_START_ROW + memberRowIndex - 1;
    const data = [
        { range: `'${SHEET_NAME}'!${columnToLetter(gpIndex + DATA_START_COLUMN)}${sheetRow}`, values: [['NO']] },
        { range: `'${SHEET_NAME}'!${columnToLetter(gpStartIndex + DATA_START_COLUMN)}${sheetRow}`, values: [['']] },
        { range: `'${SHEET_NAME}'!${columnToLetter(gpEndIndex + DATA_START_COLUMN)}${sheetRow}`, values: [['']] },
    ];
    if (notificationIndex !== -1) {
        data.push({ range: `'${SHEET_NAME}'!${columnToLetter(notificationIndex + DATA_START_COLUMN)}${sheetRow}`, values: [['NO']] });
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
    });

    return { success: true, row: sheetRow, ign };
}

async function updateMemberIGN(oldIgn, newIgn) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');

    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    if (ignIndex === -1) throw new Error('IGN column could not be found.');

    const memberRowIndex = rows.findIndex((row, index) =>
        index > 0 && normalize(row[ignIndex]) === normalize(oldIgn)
    );
    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };

    const sheetRow = DATA_START_ROW + memberRowIndex - 1;
    const ignColumn = columnToLetter(ignIndex + DATA_START_COLUMN);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!${ignColumn}${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newIgn]] },
    });

    return { success: true, row: sheetRow, oldIgn, newIgn };
}

async function addMember(ign) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member header row found.');

    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    if (ignIndex === -1) throw new Error('IGN column could not be found.');

    const exists = rows.slice(1).some(row => normalize(row[ignIndex]) === normalize(ign));
    if (exists) return { success: false, reason: 'MEMBER_EXISTS' };

    const values = Array(headers.length).fill('');
    values[ignIndex] = ign.trim();

    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!B:O`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
    });

    return { success: true, ign: ign.trim() };
}

async function deleteMember(ign) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');

    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    if (ignIndex === -1) throw new Error('IGN column could not be found.');

    const memberRowIndex = rows.findIndex((row, index) =>
        index > 0 && normalize(row[ignIndex]) === normalize(ign)
    );
    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };

    // getMembers() reads B4:O, so memberRowIndex 1 is spreadsheet row 5.
    const sheetRow = DATA_START_ROW + memberRowIndex - 1;

    // Delete the actual spreadsheet row instead of only clearing B:O.
    const metadata = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        fields: 'sheets.properties',
    });
    const sheet = (metadata.data.sheets || []).find(
        item => item.properties && item.properties.title === SHEET_NAME
    );
    if (!sheet) throw new Error(`Google Sheet tab "${SHEET_NAME}" could not be found.`);

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: sheetRow - 1,
                        endIndex: sheetRow,
                    },
                },
            }],
        },
    });

    return { success: true, ign: String(ign).trim(), row: sheetRow };
}
async function markGoldPassNotified(sheetRow) {
    const rows = await getMembers();
    const headers = rows[0] || [];
    const notificationIndex = findHeader(headers, ['GP 3 DAY NOTIFIED']);
    if (notificationIndex === -1) return;
    const notificationColumn = columnToLetter(notificationIndex + DATA_START_COLUMN);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!${notificationColumn}${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['YES']] },
    });
}

async function updateMemberRole(ign, newRole) {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');
    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    const roleIndex = findHeader(headers, ['ROLE', 'TAG', 'CLUB ROLE']);
    if (ignIndex === -1 || roleIndex === -1) throw new Error('IGN or ROLE column could not be found.');
    const memberRowIndex = rows.findIndex((row, index) => index > 0 && normalize(row[ignIndex]) === normalize(ign));
    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };
    const sheetRow = DATA_START_ROW + memberRowIndex - 1;
    const roleColumn = columnToLetter(roleIndex + DATA_START_COLUMN);
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!${roleColumn}${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newRole]] },
    });
    return { success: true, ign, newRole, row: sheetRow };
}

async function updateMemberStats(ign, statsValue, unit = 'MCS') {
    const rows = await getMembers();
    if (rows.length === 0) throw new Error('No member data found.');
    const headers = rows[0];
    const ignIndex = findHeader(headers, ['IGN']);
    const statIndex = findHeader(headers, ['STAT', 'STATS', 'COMBINED STATS']);
    if (ignIndex === -1 || statIndex === -1) throw new Error('IGN or STAT column could not be found.');
    const memberRowIndex = rows.findIndex((row, index) => index > 0 && normalize(row[ignIndex]) === normalize(ign));
    if (memberRowIndex === -1) return { success: false, reason: 'MEMBER_NOT_FOUND' };
    const sheetRow = DATA_START_ROW + memberRowIndex - 1;
    const statColumn = columnToLetter(statIndex + DATA_START_COLUMN);
    const value = `${String(statsValue).trim()} ${String(unit).toUpperCase()}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!${statColumn}${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
    });
    return { success: true, ign, statsValue: String(statsValue).trim(), unit: String(unit).toUpperCase(), row: sheetRow };
}

module.exports = {
    getMembers,
    updateGoldPass,
    removeGoldPass,
    updateMemberIGN,
    addMember,
    deleteMember,
    updateMemberRole,
    updateMemberStats,
    markGoldPassNotified,
};
