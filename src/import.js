'use strict';

// BL-119: multi-machine merge. Import a ledger exported from another machine
// (`tt export all --ledger` → native JSONL records) and fold it into this
// store. Dedup is by the unique record `id` against everything already stored
// AND within the batch, so re-importing the same file never double-counts —
// the same idempotency guarantee as `tt sync` (store.loadIds is the key set).
//
// Unlike the inbox collector (which mints fresh ids for foreign rows), import
// preserves the original id, which is what makes re-import safe.

const fs = require('fs');
const store = require('./store');

// Minimal validity: a record must carry a stable id and an ISO timestamp
// (the store keys files by ts month). Anything else is counted invalid and
// skipped rather than poisoning the store.
function valid(r) {
    return r && typeof r.id === 'string' && r.id
        && typeof r.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.ts);
}

function importLedger(files, opts = {}) {
    const dryRun = !!opts.dryRun;
    const existing = store.loadIds();
    const seen = new Set();
    const fresh = [];
    let total = 0;
    let duplicate = 0;
    let invalid = 0;

    for (const file of files) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            total++;
            let r;
            try { r = JSON.parse(line); } catch { invalid++; continue; }
            if (!valid(r)) { invalid++; continue; }
            if (existing.has(r.id) || seen.has(r.id)) { duplicate++; continue; }
            seen.add(r.id);
            fresh.push(r);
        }
    }

    if (!dryRun && fresh.length) store.append(fresh);

    return { files: files.length, total, added: fresh.length, duplicate, invalid, records: fresh };
}

module.exports = { importLedger, valid };
