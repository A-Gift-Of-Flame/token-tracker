'use strict';

// BL-121: one-time historical project backfill. `--by project` (BL-112) only
// attributes records collected after that change — the sync dedup keeps old
// requestIds from re-collecting. The on-disk Claude Code transcripts still
// carry each line's cwd, so we rebuild a requestId→project map straight from
// them and patch the stored records' `project` in place (reusing the same
// readRecords/writeRecords path as reprice). No new data source; only the
// optional `project` field is added, nothing else changes.

const fs = require('fs');
const cc = require('./collectors/claude-code');
const store = require('./store');

// Map record id → project basename, from every transcript line that parses to
// a usage record with a cwd. Same id scheme the collector writes, so the keys
// line up with stored records.
function buildProjectMap() {
    const map = new Map();
    for (const file of cc.transcriptFiles()) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line) continue;
            const rec = cc.parseLine(line);
            if (rec && rec.project) map.set(rec.id, rec.project);
        }
    }
    return map;
}

// `map` (id→project) is injectable for tests; defaults to the on-disk scan.
function backfillProjects({ dryRun = false, map = null } = {}) {
    map = map || buildProjectMap();
    let records = 0;
    let patched = 0;
    let alreadyHad = 0;
    let unmatched = 0;

    for (const file of store.listMonthFiles()) {
        const recs = store.readRecords(file);
        let changed = false;
        for (const r of recs) {
            if (r.agent !== 'claude-code') continue; // only source carrying project data
            records++;
            if (r.project) { alreadyHad++; continue; }
            const p = map.get(r.id);
            if (!p) { unmatched++; continue; }
            r.project = p;
            patched++;
            changed = true;
        }
        if (changed && !dryRun) store.writeRecords(file, recs);
    }

    return { mapped: map.size, records, patched, alreadyHad, unmatched, dryRun };
}

module.exports = { backfillProjects, buildProjectMap };
