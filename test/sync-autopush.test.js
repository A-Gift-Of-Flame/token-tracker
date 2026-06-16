'use strict';

// Verifies the feature owned by sync(): pushing to the VPS at ingest. The
// existing remote.test.js exercises remote.push() directly and would pass
// whether or not sync triggers it — so this is the only coverage that proves
// auto-push actually fires from the ingest path (CLI sync, serve loop, reports).
//
// node --test runs each file in its own process, so we fix HOME and
// TOKEN_TRACKER_DIR once up front, before requiring any collector/path module.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('node:http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-autopush-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-autopush-root-'));
process.env.HOME = home;
process.env.TOKEN_TRACKER_DIR = root;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sync } = require('../src/collectors');
const remote = require('../src/remote');

// Minimal ingest endpoint mirroring the wire contract the client owns.
async function serveIngest() {
    const requests = [];
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/api/ingest') { res.writeHead(404).end(); return; }
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const records = JSON.parse(raw);
            requests.push(records);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ added: records.length, duplicate: 0, invalid: 0 }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: 'http://127.0.0.1:' + server.address().port, requests, close: () => new Promise((r) => server.close(r)) };
}

// Drop a uniquely-keyed inbox record so each sync ingests something fresh.
let seq = 0;
function dropFresh() {
    seq++;
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'custom-' + seq + '.jsonl'),
        JSON.stringify({ ts: '2026-06-15T00:0' + seq + ':00Z', agent: 'custom', model: 'x', input: seq, output: seq }) + '\n');
}

test('autoPush on + fresh records: sync pushes to the VPS', async () => {
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 't', endpoint: api.base, autoPush: true });
        dropFresh();
        const res = await sync({ offline: true });
        assert.ok(res.total > 0, 'ingested fresh records');
        assert.ok(res.push, 'push result present');
        assert.ok(res.push.pushed > 0, 'records pushed');
        assert.equal(api.requests.length, 1, 'one ingest request hit the server');
    } finally {
        await api.close();
    }
});

test('autoPush on but no fresh records: no push', async () => {
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 't', endpoint: api.base, autoPush: true });
        const res = await sync({ offline: true }); // nothing dropped
        assert.equal(res.total, 0, 'no fresh records');
        assert.equal(res.push, undefined, 'push not attempted on empty ingest');
        assert.equal(api.requests.length, 0, 'server received nothing');
    } finally {
        await api.close();
    }
});

test('push:false suppresses push even with autoPush on and fresh records', async () => {
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 't', endpoint: api.base, autoPush: true });
        dropFresh();
        const res = await sync({ offline: true, push: false });
        assert.ok(res.total > 0, 'ingested fresh records');
        assert.equal(res.push, undefined, 'push suppressed');
        assert.equal(api.requests.length, 0, 'server received nothing');
    } finally {
        await api.close();
    }
});

test('autoPush off: fresh records do not push', async () => {
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 't', endpoint: api.base, autoPush: false });
        dropFresh();
        const res = await sync({ offline: true });
        assert.ok(res.total > 0, 'ingested fresh records');
        assert.equal(res.push, undefined, 'no push when autoPush off');
        assert.equal(api.requests.length, 0, 'server received nothing');
    } finally {
        await api.close();
    }
});
