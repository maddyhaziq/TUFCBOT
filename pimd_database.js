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

const SCHEMAS = {
    PIMD_ITEMS: ['Name', 'Category', 'Type', 'Stats', 'Description', 'Source URL', 'Source Date', 'Image URL', 'Notes', 'Last Verified'],
    PIMD_PRICES: ['Name', 'Low', 'Typical', 'High', 'Currency', 'Source', 'Source URL', 'Source Date', 'Confidence', 'Notes', 'Last Verified'],
    PIMD_FURNITURE: ['Name', 'Year/Event', 'Type', 'Stats', 'Description', 'Source URL', 'Source Date', 'Image URL', 'Notes', 'Last Verified'],
    PIMD_BOXES: ['Name', 'Type', 'Contents', 'Cost/Trade', 'Stats', 'Source URL', 'Source Date', 'Image URL', 'Notes', 'Last Verified'],
    PIMD_AVATARS: ['Name', 'Series', 'Shard Cost', 'Stats', 'Price Low', 'Price Typical', 'Price High', 'Source URL', 'Source Date', 'Image URL', 'Notes', 'Last Verified'],
    PIMD_PARTIES: ['Name', 'Type', 'Duration', 'Damage Needed', 'Drops', 'Status', 'Source URL', 'Source Date', 'Notes', 'Last Verified'],
    PIMD_SOURCES: ['Title', 'Category', 'URL', 'Source Date', 'Description', 'Last Checked'],
};

function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
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

async function getSpreadsheetMeta() {
    return sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
}

async function ensureDatabaseSheets() {
    const meta = await getSpreadsheetMeta();
    const existing = new Map((meta.data.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
    const requests = [];

    for (const title of Object.keys(SCHEMAS)) {
        if (!existing.has(title)) requests.push({ addSheet: { properties: { title } } });
    }

    if (requests.length) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
    }

    const refreshed = await getSpreadsheetMeta();
    const sheetMap = new Map((refreshed.data.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));

    for (const [title, headers] of Object.entries(SCHEMAS)) {
        const range = `'${title}'!A1:${columnToLetter(headers.length)}1`;
        const current = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range }).catch(() => ({ data: {} }));
        const row = current.data.values?.[0] || [];
        const needsHeader = headers.some((header, i) => normalize(row[i]) !== normalize(header));
        if (needsHeader) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range,
                valueInputOption: 'RAW',
                requestBody: { values: [headers] },
            });
        }
    }

    return sheetMap;
}

async function getRecords(sheetName) {
    if (!SCHEMAS[sheetName]) throw new Error(`Unknown PIMD database sheet: ${sheetName}`);
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A:Z`,
        valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = response.data.values || [];
    if (!rows.length) return [];
    const headers = rows[0];
    return rows.slice(1).filter(row => row.some(v => String(v ?? '').trim() !== '')).map(row => {
        const record = {};
        headers.forEach((header, i) => { if (header) record[String(header).trim()] = row[i] ?? ''; });
        return record;
    });
}

function recordMatches(record, query) {
    const needle = normalize(query);
    if (!needle) return false;
    const candidates = [record.Name, record.Alias, record['Source URL']].filter(Boolean).map(normalize);
    return candidates.some(v => v === needle) || candidates.some(v => v.includes(needle) || needle.includes(v));
}

async function searchDatabase(query, sheetNames = Object.keys(SCHEMAS)) {
    const results = [];
    for (const sheetName of sheetNames) {
        const records = await getRecords(sheetName);
        for (const record of records) {
            if (recordMatches(record, query)) results.push({ sheet: sheetName, record });
        }
    }
    return results;
}

async function appendRecord(sheetName, values) {
    if (!SCHEMAS[sheetName]) throw new Error(`Unknown PIMD database sheet: ${sheetName}`);
    const headers = SCHEMAS[sheetName];
    const row = headers.map(header => values[header] ?? '');
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A:${columnToLetter(headers.length)}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
    });
    return Object.fromEntries(headers.map((header, i) => [header, row[i]]));
}

async function upsertByName(sheetName, values) {
    if (!SCHEMAS[sheetName]) throw new Error(`Unknown PIMD database sheet: ${sheetName}`);
    const name = normalize(values.Name);
    if (!name) throw new Error('Name is required.');
    const records = await getRecords(sheetName);
    const index = records.findIndex(r => normalize(r.Name) === name);
    const headers = SCHEMAS[sheetName];

    if (index === -1) return { action: 'inserted', record: await appendRecord(sheetName, values) };

    const rowNumber = index + 2;
    const row = headers.map(header => values[header] ?? records[index][header] ?? '');
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${rowNumber}:${columnToLetter(headers.length)}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
    });
    return { action: 'updated', record: Object.fromEntries(headers.map((header, i) => [header, row[i]])) };
}

module.exports = {
    SCHEMAS,
    ensureDatabaseSheets,
    getRecords,
    searchDatabase,
    appendRecord,
    upsertByName,
};
