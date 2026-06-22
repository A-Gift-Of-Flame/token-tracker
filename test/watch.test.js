'use strict';

// One tick of `tt watch`. The loop itself is just setInterval over watchTick,
// so testing a single tick (push happens, errors are swallowed, logs reflect
// outcome) is the meaningful coverage.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('node:http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-watch-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-watch-root-'));
process.env.HOME = home;
process.env.TOKEN_TRACKER_DIR = root;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { watchTick } = require('../src/watch');
const remote = require('../src/remote');

async function serveIngest() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            requests.push(JSON.parse(raw));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ added: 1, duplicate: 0, invalid: 0 }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: 'http://127.0.0.1:' + server.address().port, requests, close: () => new Promise((r) => server.close(r)) };
}

let seq = 0;
function dropFresh() {
    seq++;
    // Forward-moving real timestamp: each record is newer than any pushedAt a
    // prior test advanced, so push() never filters it out by the high-water mark.
    const ts = new Date(Date.now() + seq * 60000).toISOString();
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'custom-' + seq + '.jsonl'),
        JSON.stringify({ ts, agent: 'custom', model: 'x', input: seq, output: seq }) + '\n');
}

test('watchTick syncs and pushes fresh records, logs the push', async () => {
    const api = await serveIngest();
    const logs = [];
    process.env.TT_ENDPOINT = api.base;
    try {
        remote.saveRemote({ token: 't', autoPush: true });
        dropFresh();
        const res = await watchTick({ offline: true, log: (m) => logs.push(m), errlog: (m) => logs.push('ERR ' + m) });
        assert.ok(res && res.push && res.push.pushed > 0, 'pushed');
        assert.equal(api.requests.length, 1, 'server got the records');
        assert.ok(logs.some((l) => l.includes('pushed')), 'logged a push line');
    } finally {
        delete process.env.TT_ENDPOINT;
        await api.close();
    }
});

test('watchTick never throws when push endpoint is down; reports pushError', async () => {
    const logs = [];
    // Point at a closed port so the push fails.
    process.env.TT_ENDPOINT = 'http://127.0.0.1:1';
    try {
        remote.saveRemote({ token: 't', autoPush: true });
        dropFresh();
        const res = await watchTick({ offline: true, log: (m) => logs.push(m), errlog: (m) => logs.push('ERR ' + m) });
        assert.ok(res, 'tick returned (did not throw)');
        assert.ok(res.pushError, 'pushError surfaced');
        assert.ok(logs.some((l) => l.startsWith('ERR') && l.includes('auto-push failed')), 'logged the failure');
    } finally {
        delete process.env.TT_ENDPOINT;
    }
});
