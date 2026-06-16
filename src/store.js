'use strict';

// Append-only JSONL store, one file per month (data/YYYY-MM.jsonl).
// Record shape:
//   { id, ts, agent, model, input, output, cacheRead, cacheWrite, cost, priced }
//   + optional project: the session cwd basename (Claude Code only; others omit
//     it and degrade to "—" under `--by project`).
//   + optional cacheWrite1h: the 1h-TTL portion of cacheWrite (priced at 2x
//     input vs 1.25x for 5m writes). Records without it are all-5m — older
//     records stay valid as-is, no migration.
// `id` is unique per record and is the dedup key across syncs.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, STATE_FILE, ensureDirs, readJson, writeJson } = require('./paths');

function monthKey(ts) {
    return ts.slice(0, 7); // "YYYY-MM" from ISO timestamp
}

function monthFile(key) {
    return path.join(DATA_DIR, key + '.jsonl');
}

function listMonthFiles() {
    ensureDirs();
    return fs.readdirSync(DATA_DIR)
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .sort()
        .map((f) => path.join(DATA_DIR, f));
}

// Set of every record id in the store. Guarantees idempotent syncs even if
// collector state (file offsets) is lost.
function loadIds() {
    const ids = new Set();
    for (const file of listMonthFiles()) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            try { ids.add(JSON.parse(line).id); } catch { /* skip bad line */ }
        }
    }
    return ids;
}

function append(records) {
    ensureDirs();
    const byMonth = new Map();
    for (const r of records) {
        const key = monthKey(r.ts);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(JSON.stringify(r));
    }
    for (const [key, lines] of byMonth) {
        fs.appendFileSync(monthFile(key), lines.join('\n') + '\n');
    }
}

// Load records whose timestamp falls in [fromIso, toIso). Pass null for open ends.
function loadRange(fromIso, toIso) {
    const out = [];
    for (const file of listMonthFiles()) {
        const key = path.basename(file, '.jsonl');
        if (fromIso && key < fromIso.slice(0, 7)) continue;
        if (toIso && key > toIso.slice(0, 7)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            if (fromIso && r.ts < fromIso) continue;
            if (toIso && r.ts >= toIso) continue;
            out.push(r);
        }
    }
    return out;
}

// Insertion-order high-water mark for remote push. The store is append-only
// per-month JSONL, so per-file record COUNT is a monotonic mark that survives
// out-of-order timestamps — a record flushed late with a past ts still appends
// to the end of its month file and lands beyond the saved count. (A ts-based
// mark silently drops such records: opencode/codex write a whole session's
// records at exit, all timestamped < the mark that claude-code already advanced
// to ~now.) Returns the unpushed records plus the new per-file counts to persist
// on a successful push. `offsets` maps "YYYY-MM" -> count already pushed.
function loadUnpushed(offsets = {}) {
    const records = [];
    const counts = {};
    for (const file of listMonthFiles()) {
        const key = path.basename(file, '.jsonl');
        const recs = readRecords(file);
        counts[key] = recs.length;
        const start = Math.min(offsets[key] || 0, recs.length);
        for (let i = start; i < recs.length; i++) records.push(recs[i]);
    }
    return { records, counts };
}

// Parse every record in one month file (skips blank/corrupt lines).
function readRecords(file) {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    return out;
}

// Atomically overwrite one month file with the given records (tmp + rename).
// Used by reprice — append-only is relaxed here since ids/timestamps are
// preserved and only the derived cost changes.
function writeRecords(file, records) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
}

function loadState() {
    return readJson(STATE_FILE, { collectors: {} });
}

function saveState(state) {
    writeJson(STATE_FILE, state);
}

module.exports = { append, loadRange, loadUnpushed, loadIds, loadState, saveState, listMonthFiles, readRecords, writeRecords };
