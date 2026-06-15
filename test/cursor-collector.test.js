'use strict';

// BL-122: Cursor collector smoke test.
//
// Cursor's store.db has two tables: meta (hex-encoded JSON with agentId +
// latestRootBlobId) and blobs (id TEXT, data BLOB). Blobs are either JSON
// (message content) or protobuf (tree nodes with context-window token usage).
//
// We build a minimal synthetic DB in a temp dir — no file-system fixtures
// needed. We encode the root protobuf blob by hand (field 5 carries the
// context-window totals; field 9 carries the project file URL).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// --- minimal protobuf encoder ------------------------------------------------

function encVarint(v) {
    const out = [];
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v & 0x7f);
    return Buffer.from(out);
}

function encField(fieldNum, wireType, data) {
    const tag = encVarint((fieldNum << 3) | wireType);
    if (wireType === 0) return Buffer.concat([tag, encVarint(data)]);
    const len = encVarint(data.length);
    return Buffer.concat([tag, len, data]);
}

function buildRootBlob(contextTokens, projectUrl) {
    // field 5 nested: f1=contextTokens (varint), f2=200000 (varint)
    const f5inner = Buffer.concat([
        encField(1, 0, contextTokens),
        encField(2, 0, 200000),
    ]);
    const f5 = encField(5, 2, f5inner);
    // field 9: project file URL
    const f9 = encField(9, 2, Buffer.from(projectUrl));
    return Buffer.concat([f5, f9]);
}

function buildAssistantBlob(modelName) {
    return Buffer.from(JSON.stringify({
        role: 'assistant',
        content: [{
            type: 'text',
            text: 'hello',
            providerOptions: { cursor: { modelName } },
        }],
    }));
}

function buildDb(dir, { agentId, chatId, createdAt, contextTokens, model, projectUrl }) {
    const dbPath = path.join(dir, 'store.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');

    const rootBlobId = 'aaaa' + '0'.repeat(60); // fake SHA-256
    const assistantBlobId = 'bbbb' + '0'.repeat(60);

    const metaVal = JSON.stringify({ agentId, createdAt, latestRootBlobId: rootBlobId, name: 'Test' });
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(metaVal).toString('hex'));

    const rootBlob = buildRootBlob(contextTokens, projectUrl);
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run(rootBlobId, rootBlob);
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run(assistantBlobId, buildAssistantBlob(model));

    db.close();
    return dbPath;
}

// --- helper: stage a fake ~/.cursor tree -------------------------------------

function stageCursor(home, sessions) {
    for (const s of sessions) {
        const dir = path.join(home, '.cursor', 'chats', s.chatId, s.agentId);
        fs.mkdirSync(dir, { recursive: true });
        buildDb(dir, s);
    }
    return path.join(home, '.cursor');
}

// =============================================================================

test('cursor collector extracts context tokens, model, and project from store.db', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cursor-'));
    const agentId = 'dddddddd-1111-2222-3333-eeeeeeeeeeee';
    const chatId = 'ffff' + '0'.repeat(28);

    const cursorRoot = stageCursor(home, [{
        agentId,
        chatId,
        createdAt: 1781386747699,
        contextTokens: 12000,
        model: 'cursor-small',
        projectUrl: 'file:///home/user/projects/my-repo',
    }]);

    const cursor = require('../src/collectors/cursor');
    const state = {};
    const recs = cursor.collect(state, cursorRoot);

    assert.equal(recs.length, 1, 'one record per session');
    const r = recs[0];
    assert.equal(r.id, 'cursor:' + agentId);
    assert.equal(r.agent, 'cursor');
    assert.equal(r.provider, 'cursor');
    assert.equal(r.model, 'cursor-small');
    assert.equal(r.input, 12000, 'context tokens stored as input');
    assert.equal(r.output, 0);
    assert.equal(r.cacheRead, 0);
    assert.equal(r.cacheWrite, 0);
    assert.equal(r.project, 'my-repo', 'project from file URL basename');
    assert.equal(r.ts, new Date(1781386747699).toISOString());

    assert.deepEqual(state.processedSessions, [agentId], 'agentId saved to state');

    // idempotent: re-collect with carried state emits nothing
    const recs2 = cursor.collect(state, cursorRoot);
    assert.equal(recs2.length, 0, 'no records on re-collect with carried state');
});

test('cursor collector skips session with no context tokens', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cursor-empty-'));
    const agentId = 'aaaaaaaa-dead-beef-0000-111111111111';
    const chatId = '0000' + '0'.repeat(28);

    const cursorRoot = stageCursor(home, [{
        agentId,
        chatId,
        createdAt: Date.now(),
        contextTokens: 0, // empty session — no tokens
        model: 'cursor-small',
        projectUrl: 'file:///tmp',
    }]);

    const cursor = require('../src/collectors/cursor');
    const recs = cursor.collect({}, cursorRoot);
    assert.equal(recs.length, 0, 'empty session skipped');
});
