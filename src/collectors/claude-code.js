'use strict';

// Claude Code collector — reads session transcripts under
// ~/.claude/projects/**/*.jsonl. Assistant lines carry `message.usage` with
// input/output/cache token counts. A single API request can span several
// JSONL lines (streamed content blocks) that repeat the same `requestId` and
// identical usage, so records are keyed by requestId.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'claude-code';

function transcriptFiles() {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const out = [];
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { return out; }
    for (const d of dirs) {
        const dir = path.join(root, d);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
        }
    }
    return out;
}

function collect(state) {
    const st = state.files || (state.files = {});
    const records = [];
    for (const file of transcriptFiles()) {
        let size;
        try { size = fs.statSync(file).size; } catch { continue; }
        let offset = st[file] || 0;
        if (offset > size) offset = 0; // file rewritten — rescan (store dedup catches repeats)
        if (offset === size) continue;
        let text;
        try {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            text = buf.toString('utf8');
        } catch { continue; }
        // Only consume complete lines; partial tail is re-read next sync.
        const lastNl = text.lastIndexOf('\n');
        if (lastNl === -1) continue;
        st[file] = offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
        for (const line of text.slice(0, lastNl).split('\n')) {
            const rec = parseLine(line);
            if (rec) records.push(rec);
        }
    }
    return records;
}

// Parse one transcript JSONL line into a usage record, or null.
function parseLine(line) {
    if (!line.includes('"usage"')) return null;
    let e;
    try { e = JSON.parse(line); } catch { return null; }
    if (e.type !== 'assistant' || !e.message || !e.message.usage) return null;
    const u = e.message.usage;
    const reqId = e.requestId || e.message.id || e.uuid;
    if (!reqId) return null;
    // Skip synthetic/error placeholder messages with no usage
    if (!(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens)) return null;
    const rec = {
        id: NAME + ':' + reqId,
        ts: e.timestamp || new Date().toISOString(),
        agent: NAME,
        model: e.message.model || 'unknown',
        provider: 'anthropic',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
    };
    // Project attribution (BL-112): transcript lines carry the session cwd.
    // Store its basename as a friendly grouping label (same-basename repos in
    // different paths collapse together — acceptable for a usage breakdown).
    if (e.cwd) rec.project = path.basename(String(e.cwd)) || undefined;
    // Newer transcripts split cache writes by TTL: cache_creation_input_tokens
    // equals ephemeral_5m_input_tokens + ephemeral_1h_input_tokens. Record the
    // 1h portion so pricing can apply the 2x write tier (5m is 1.25x). Older
    // lines without the split mean all-5m — cacheWrite1h stays omitted.
    if (u.cache_creation) {
        rec.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
    }
    return rec;
}

module.exports = { name: NAME, collect, parseLine, transcriptFiles };
