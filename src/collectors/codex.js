'use strict';

// OpenAI Codex CLI collector — reads rollout files under
// ~/.codex/sessions/**/*.jsonl. Each `token_count` event carries
// `info.last_token_usage` for the request that just finished; the current
// model comes from the preceding `turn_context` / `session_meta` line.
// Events have no stable id, so records are keyed by file + line number
// (rollout files are append-only).

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'codex';

function rolloutFiles() {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.jsonl')) out.push(p);
        }
    };
    walk(root);
    return out;
}

function collect(state) {
    const st = state.files || (state.files = {});
    const records = [];
    for (const file of rolloutFiles()) {
        let size;
        try { size = fs.statSync(file).size; } catch { continue; }
        const fst = st[file] || (st[file] = { offset: 0, line: 0, model: '' });
        if (fst.offset > size) { fst.offset = 0; fst.line = 0; }
        if (fst.offset === size) continue;
        let text;
        try {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - fst.offset);
            fs.readSync(fd, buf, 0, buf.length, fst.offset);
            fs.closeSync(fd);
            text = buf.toString('utf8');
        } catch { continue; }
        const lastNl = text.lastIndexOf('\n');
        if (lastNl === -1) continue;
        fst.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
        for (const line of text.slice(0, lastNl).split('\n')) {
            fst.line++;
            if (!line) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            const p = e.payload || {};
            if ((e.type === 'turn_context' || e.type === 'session_meta') && p.model) {
                fst.model = p.model;
                continue;
            }
            if (e.type !== 'event_msg' || p.type !== 'token_count') continue;
            const u = (p.info && p.info.last_token_usage) || null;
            if (!u) continue;
            const cached = u.cached_input_tokens || 0;
            records.push({
                id: NAME + ':' + path.basename(file) + ':' + fst.line,
                ts: e.timestamp || new Date().toISOString(),
                agent: NAME,
                model: fst.model || 'gpt-5',
                provider: 'openai',
                // Codex input_tokens includes cached tokens — split them out
                input: Math.max(0, (u.input_tokens || 0) - cached),
                output: (u.output_tokens || 0),
                cacheRead: cached,
                cacheWrite: 0,
            });
        }
    }
    return records;
}

module.exports = { name: NAME, collect };
