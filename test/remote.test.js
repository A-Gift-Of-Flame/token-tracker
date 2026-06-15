'use strict';

// Public-client remote push tests. These intentionally do not import the
// hosted server implementation; a tiny local HTTP handler verifies the wire
// behavior the CLI client owns.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert/strict');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-remote-test-'));
}

function makeEnv() {
    const dir = makeTempDir();
    process.env.TOKEN_TRACKER_DIR = dir;
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/src/paths') || key.includes('/src/remote') || key.includes('/src/store')) {
            delete require.cache[key];
        }
    }
    const remote = require('../src/remote');
    const store = require('../src/store');
    return { dir, remote, store };
}

async function serveIngest() {
    const ids = new Set();
    const requests = [];
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/api/ingest') {
            res.writeHead(404).end('not found');
            return;
        }
        if (req.headers.authorization !== 'Bearer test-token') {
            res.writeHead(401).end('unauthorized');
            return;
        }
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            let records;
            try { records = JSON.parse(raw); } catch {
                res.writeHead(400).end('bad json');
                return;
            }
            requests.push(records);
            let added = 0;
            let duplicate = 0;
            let invalid = 0;
            for (const rec of records) {
                if (!rec || typeof rec.id !== 'string') { invalid++; continue; }
                if (ids.has(rec.id)) duplicate++;
                else { ids.add(rec.id); added++; }
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ added, duplicate, invalid }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        base: 'http://127.0.0.1:' + server.address().port,
        ids,
        requests,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test('saveRemote / loadRemote round-trip; file mode is 0600', () => {
    const { dir, remote } = makeEnv();
    try {
        assert.equal(remote.loadRemote(), null, 'no config yet');
        remote.saveRemote({ token: 'abc', endpoint: 'https://tt.example.com' });
        const loaded = remote.loadRemote();
        assert.equal(loaded.token, 'abc');
        assert.equal(loaded.endpoint, 'https://tt.example.com');

        const stat = fs.statSync(remote.REMOTE_FILE);
        const mode = stat.mode & 0o777;
        assert.equal(mode, 0o600, 'remote.json must be 0600');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('remoteStatus: not configured', () => {
    const { dir, remote } = makeEnv();
    try {
        const s = remote.remoteStatus();
        assert.equal(s.configured, false);
        assert.equal(s.endpoint, null);
        assert.equal(s.pushedAt, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('remoteStatus: configured + pushedAt from state', () => {
    const { dir, remote, store } = makeEnv();
    try {
        remote.saveRemote({ token: 't', endpoint: 'https://x.com' });
        const state = store.loadState();
        state.remote = { pushedAt: '2026-06-15T00:00:00.000Z' };
        store.saveState(state);

        const s = remote.remoteStatus();
        assert.equal(s.configured, true);
        assert.equal(s.endpoint, 'https://x.com');
        assert.equal(s.pushedAt, '2026-06-15T00:00:00.000Z');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('push sends records and updates pushedAt', async () => {
    const { dir, remote, store } = makeEnv();
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 'test-token', endpoint: api.base });
        store.append([
            { id: 'r1', ts: '2026-06-14T01:00:00Z', agent: 'claude-code', model: 'm', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001, priced: true },
            { id: 'r2', ts: '2026-06-14T02:00:00Z', agent: 'claude-code', model: 'm', input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.002, priced: true },
        ]);

        const result = await remote.push();
        assert.equal(result.added, 2);
        assert.equal(result.duplicate, 0);
        assert.equal(result.pushed, 2);
        assert.equal(api.ids.size, 2);
        assert.equal(api.requests.length, 1);
        assert.ok(store.loadState().remote.pushedAt, 'pushedAt written to state');
    } finally {
        await api.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('re-push is idempotent: same records counted as duplicate', async () => {
    const { dir, remote, store } = makeEnv();
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 'test-token', endpoint: api.base });
        store.append([
            { id: 'idem1', ts: '2026-06-14T01:00:00Z', agent: 'a', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false },
        ]);

        const first = await remote.push();
        assert.equal(first.added, 1);

        const second = await remote.push({ since: 'all' });
        assert.equal(second.added, 0);
        assert.equal(second.duplicate, 1);
        assert.equal(api.ids.size, 1);
    } finally {
        await api.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('push with --since filters to newer records only', async () => {
    const { dir, remote, store } = makeEnv();
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 'test-token', endpoint: api.base });
        store.append([
            { id: 'old1', ts: '2026-06-10T00:00:00Z', agent: 'a', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false },
            { id: 'new1', ts: '2026-06-15T00:00:00Z', agent: 'a', model: 'm', input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false },
        ]);

        const result = await remote.push({ since: '2026-06-12T00:00:00Z' });
        assert.equal(result.pushed, 1);
        assert.equal(result.added, 1);
        assert.deepEqual(api.requests[0].map((r) => r.id), ['new1']);
    } finally {
        await api.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('push with nothing new returns zero counts without request', async () => {
    const { dir, remote } = makeEnv();
    const api = await serveIngest();
    try {
        remote.saveRemote({ token: 'test-token', endpoint: api.base });
        const result = await remote.push();
        assert.equal(result.pushed, 0);
        assert.equal(result.added, 0);
        assert.equal(api.requests.length, 0);
    } finally {
        await api.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
