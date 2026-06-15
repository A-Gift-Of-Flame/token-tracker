'use strict';

// Gemini CLI collector — reads session transcripts from ~/.gemini/tmp/ and
// ~/.gemini/history/ (per-project subdirs, each with a chats/ dir of JSONL
// files). Lines with type "gemini" carry per-turn token usage:
//   { input, output, cached, thoughts, tool, total }
// cached = context-cache reads (billed at the cheap cache-read rate).
// thoughts = thinking tokens (billed at the output rate, folded into output).
// tool = tool-call tokens (billed at the input rate, folded into input).
// No cache-write field — Gemini CLI doesn't expose cache-creation counts.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'gemini-cli';

function sessionFiles(geminiRoot) {
    const root = geminiRoot || path.join(os.homedir(), '.gemini');
    const out = [];
    for (const sub of ['tmp', 'history']) {
        const subDir = path.join(root, sub);
        let projects;
        try { projects = fs.readdirSync(subDir); } catch { continue; }
        for (const p of projects) {
            const chatsDir = path.join(subDir, p, 'chats');
            let files;
            try { files = fs.readdirSync(chatsDir); } catch { continue; }
            for (const f of files) {
                if (f.endsWith('.jsonl')) out.push(path.join(chatsDir, f));
            }
        }
    }
    return out;
}

function parseLine(line) {
    if (!line.includes('"gemini"')) return null;
    let e;
    try { e = JSON.parse(line); } catch { return null; }
    if (e.type !== 'gemini' || !e.tokens || !e.id) return null;
    const t = e.tokens;
    if (!(t.input || t.output || t.cached || t.thoughts || t.tool)) return null;
    return {
        id: NAME + ':' + e.id,
        ts: e.timestamp,
        agent: NAME,
        model: e.model || 'unknown',
        provider: 'gemini',
        input: (t.input || 0) + (t.tool || 0),
        output: (t.output || 0) + (t.thoughts || 0),
        cacheRead: t.cached || 0,
        cacheWrite: 0,
    };
}

function collect(state, geminiRoot) {
    const st = state.files || (state.files = {});
    const records = [];
    for (const file of sessionFiles(geminiRoot)) {
        // Extract project name from path: .../tmp/<project>/chats/session.jsonl
        const project = path.basename(path.dirname(path.dirname(file)));
        let size;
        try { size = fs.statSync(file).size; } catch { continue; }
        let offset = st[file] || 0;
        if (offset > size) offset = 0; // file rewritten — rescan
        if (offset === size) continue;
        let text;
        try {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            text = buf.toString('utf8');
        } catch { continue; }
        const lastNl = text.lastIndexOf('\n');
        if (lastNl === -1) continue;
        st[file] = offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
        for (const line of text.slice(0, lastNl).split('\n')) {
            const rec = parseLine(line);
            if (rec) {
                rec.project = project;
                records.push(rec);
            }
        }
    }
    return records;
}

module.exports = { name: NAME, collect, parseLine, sessionFiles };
