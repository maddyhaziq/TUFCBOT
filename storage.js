'use strict';

const fs = require('fs');
const path = require('path');

// Railway automatically provides RAILWAY_VOLUME_MOUNT_PATH when a Volume is attached.
// DATA_DIR can be set explicitly for local testing or another hosting provider.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SEED_DIR = path.join(__dirname, 'data-seed');

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // On a fresh Railway volume, seed the existing bot state once. Existing files are never overwritten.
    for (const filename of ['ec_timers.json', 'event_state.json', 'potd_state.json']) {
        const target = path.join(DATA_DIR, filename);
        const seed = path.join(SEED_DIR, filename);
        if (!fs.existsSync(target) && fs.existsSync(seed)) {
            fs.copyFileSync(seed, target);
        }
    }
}

function statePath(filename) {
    ensureDataDir();
    return path.join(DATA_DIR, filename);
}

ensureDataDir();

module.exports = { DATA_DIR, statePath, ensureDataDir };
