'use strict';

// OpenCode collector — reads assistant messages from the OpenCode sqlite
// database (~/.local/share/opencode/opencode.db) via node:sqlite (Node 22+).
// Message `data` JSON carries modelID/providerID and a tokens object:
//   { input, output, reasoning, cache: { read, write } }

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'opencode';
const DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function collect(state) {
    if (!fs.existsSync(DB)) return [];
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return []; }
    const records = [];
    let db;
    try {
        db = new DatabaseSync(DB, { readOnly: true });
        const since = state.lastTime || 0;
        const rows = db.prepare(
            'SELECT id, time_created, data FROM message WHERE time_created > ? ORDER BY time_created'
        ).all(since);
        for (const row of rows) {
            state.lastTime = row.time_created;
            let d;
            try { d = JSON.parse(row.data); } catch { continue; }
            if (d.role !== 'assistant' || !d.tokens) continue;
            const t = d.tokens;
            const cache = t.cache || {};
            const ms = (d.time && (d.time.completed || d.time.created)) || row.time_created;
            records.push({
                id: NAME + ':' + row.id,
                ts: new Date(ms).toISOString(),
                agent: NAME,
                model: d.modelID || 'unknown',
                provider: d.providerID || '',
                input: t.input || 0,
                output: (t.output || 0) + (t.reasoning || 0),
                cacheRead: cache.read || 0,
                cacheWrite: cache.write || 0,
            });
        }
    } catch {
        return records;
    } finally {
        try { if (db) db.close(); } catch { /* ignore */ }
    }
    return records;
}

module.exports = { name: NAME, collect };
