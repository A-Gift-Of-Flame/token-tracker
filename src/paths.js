'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = process.env.TOKEN_TRACKER_DIR
    || path.join(os.homedir(), '.token-tracker');

const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(ROOT, 'state.json');
const PRICING_FILE = path.join(ROOT, 'pricing.json');

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
}

module.exports = { ROOT, DATA_DIR, STATE_FILE, PRICING_FILE, ensureDirs, readJson, writeJson };
