'use strict';

// Drop-in collector for any agent without a dedicated collector (Gemini,
// Cursor, Copilot, ChatGPT exports, custom scripts...). Drop JSONL files into
// ~/.token-tracker/inbox/ and every line is ingested:
//
//   {"ts":"2026-06-13T10:00:00Z","agent":"gemini-cli","model":"gemini-3-pro",
//    "input":1200,"output":340,"cacheRead":0,"cacheWrite":0}
//
// `ts` defaults to now; `agent` defaults to the file name. Files are renamed
// to *.imported after ingestion so they are never double-counted.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../paths');

const NAME = 'inbox';
const INBOX = path.join(ROOT, 'inbox');

function collect() {
    fs.mkdirSync(INBOX, { recursive: true });
    const records = [];
    let files;
    try { files = fs.readdirSync(INBOX); } catch { return records; }
    for (const f of files) {
        if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
        const file = path.join(INBOX, f);
        const fallbackAgent = f.replace(/\.(jsonl|json)$/, '');
        let n = 0;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            n++;
            const ts = e.ts || new Date().toISOString();
            records.push({
                id: NAME + ':' + f + ':' + n + ':' + ts,
                ts,
                agent: e.agent || fallbackAgent,
                model: e.model || 'unknown',
                provider: e.provider || '',
                input: e.input || 0,
                output: e.output || 0,
                cacheRead: e.cacheRead || 0,
                cacheWrite: e.cacheWrite || 0,
            });
        }
        fs.renameSync(file, file + '.imported');
    }
    return records;
}

module.exports = { name: NAME, collect };
