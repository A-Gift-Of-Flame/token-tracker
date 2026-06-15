'use strict';

// Cursor collector — reads ~/.cursor/chats/<chatId>/<agentId>/store.db.
//
// Each store.db has two tables: meta (one row, hex-encoded JSON with agentId
// and createdAt) and blobs (id TEXT, data BLOB).  Blobs are either JSON
// (conversation messages) or protobuf (tree nodes with context-window usage).
//
// What we can extract:
//   input  — total context-window tokens from the root protobuf blob (field 5,
//             sub-field 1).  This is the context size at session end, not a
//             per-request API input count, but it's the only token signal
//             available locally.
//   output — 0 (not stored in local DB; Cursor proxies requests server-side)
//   model  — from providerOptions.cursor.modelName in assistant message blobs
//   ts     — createdAt from the meta row
//   project — basename of the file URL in root blob field 9
//
// Cursor is a subscription service; cost comes back $0 (model not in LiteLLM
// table → priced=false, cost=0).
//
// One record per agentId. Sessions with no root blob or no context tokens are
// skipped (empty/corrupt sessions).

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'cursor';

// --- minimal protobuf varint + field parser (no deps) ------------------------

function readVarint(buf, off) {
    let val = 0, shift = 0, i = off;
    while (i < buf.length) {
        const b = buf[i++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
    }
    return { val, off: i };
}

function parseTopFields(buf) {
    const fields = [];
    let off = 0;
    while (off < buf.length) {
        try {
            const tag = readVarint(buf, off); off = tag.off;
            const fieldNum = tag.val >> 3;
            const wireType = tag.val & 7;
            if (fieldNum <= 0 || fieldNum > 10000) break;
            if (wireType === 0) {
                const v = readVarint(buf, off); off = v.off;
                fields.push({ fn: fieldNum, v: v.val });
            } else if (wireType === 2) {
                const l = readVarint(buf, off); off = l.off;
                fields.push({ fn: fieldNum, d: buf.slice(off, off + l.val) });
                off += l.val;
            } else break;
        } catch { break; }
    }
    return fields;
}

// Extract context-window total token count and project URL from root blob.
// Root blob layout (protobuf):
//   field 1 (repeated): 32-byte blob-ID SHA-256 hashes (child blobs)
//   field 5: nested proto with f1=total_tokens, f2=context_limit, f3=summaries
//   field 9: project file URL (e.g. "file:///home/user/projects/my-repo")
function parseRootBlob(buf) {
    const top = parseTopFields(buf);
    const f5 = top.find(x => x.fn === 5 && x.d);
    const f9 = top.find(x => x.fn === 9 && x.d);
    if (!f5) return null;
    const f5fields = parseTopFields(f5.d);
    const contextTokens = f5fields.find(x => x.fn === 1 && x.v !== undefined)?.v || 0;
    const projectUrl = f9 ? f9.d.toString('utf8') : null;
    return { contextTokens, projectUrl };
}

// --- DB discovery + parsing ---------------------------------------------------

function findStoreDbs(cursorRoot) {
    const chatsDir = path.join(cursorRoot || path.join(os.homedir(), '.cursor'), 'chats');
    const out = [];
    let chatIds;
    try { chatIds = fs.readdirSync(chatsDir); } catch { return out; }
    for (const chatId of chatIds) {
        const chatDir = path.join(chatsDir, chatId);
        let agentIds;
        try { agentIds = fs.readdirSync(chatDir); } catch { continue; }
        for (const agentId of agentIds) {
            const db = path.join(chatDir, agentId, 'store.db');
            if (fs.existsSync(db)) out.push({ chatId, agentId, db });
        }
    }
    return out;
}

function parseSession(dbPath) {
    // node:sqlite — requires Node 22+; throws if unavailable (caught by sync())
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(dbPath, { readonly: true }); } catch { return null; }
    try {
        const metaRows = db.prepare('SELECT value FROM meta WHERE key=?').all('0');
        if (!metaRows.length) return null;
        let meta;
        try { meta = JSON.parse(Buffer.from(metaRows[0].value, 'hex').toString('utf8')); } catch { return null; }
        const { agentId, createdAt, latestRootBlobId } = meta;
        if (!agentId || !latestRootBlobId) return null;

        const rootRow = db.prepare('SELECT data FROM blobs WHERE id=?').get(latestRootBlobId);
        if (!rootRow) return null;
        const rootBuf = Buffer.from(rootRow.data);
        const parsed = parseRootBlob(rootBuf);
        if (!parsed || parsed.contextTokens === 0) return null;

        // Extract model from assistant message blobs (JSON blobs)
        let model = 'unknown';
        const allBlobs = db.prepare('SELECT data FROM blobs').all();
        outer: for (const row of allBlobs) {
            let j;
            try { j = JSON.parse(Buffer.from(row.data).toString('utf8')); } catch { continue; }
            if (j.role !== 'assistant') continue;
            for (const c of j.content || []) {
                const m = c.providerOptions?.cursor?.modelName;
                if (m) { model = m; break outer; }
            }
        }

        const project = parsed.projectUrl
            ? path.basename(parsed.projectUrl.replace(/^file:\/\//, ''))
            : null;

        return {
            agentId,
            ts: new Date(createdAt).toISOString(),
            model,
            contextTokens: parsed.contextTokens,
            project,
        };
    } finally {
        db.close();
    }
}

function collect(state, cursorRoot) {
    const processed = new Set(state.processedSessions || []);
    const records = [];

    for (const { agentId, db } of findStoreDbs(cursorRoot)) {
        if (processed.has(agentId)) continue;

        const session = parseSession(db);
        if (!session) {
            // Mark clearly-empty sessions done so we don't re-read them every sync.
            // Only if agentId matches path (sanity check already done above).
            continue;
        }

        processed.add(agentId);
        const rec = {
            id: NAME + ':' + agentId,
            ts: session.ts,
            agent: NAME,
            model: session.model,
            provider: NAME, // subscription; not in LiteLLM → cost=0, priced=false
            input: session.contextTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        if (session.project) rec.project = session.project;
        records.push(rec);
    }

    state.processedSessions = [...processed];
    return records;
}

module.exports = { NAME, name: NAME, collect, findStoreDbs, parseSession, parseRootBlob };
