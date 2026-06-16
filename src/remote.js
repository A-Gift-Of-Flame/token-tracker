'use strict';

// BL-129: CLI push client. Zero-dep transport (global fetch / node:http+https
// fallback). No background push — explicit tt push only. Token stored in
// remote.json at 0600 so the plaintext is not readable by other users on the
// host. High-water mark (pushedAt) in state.json so re-push is always
// idempotent — the server dedups by (user_id, record id) anyway.

const fs = require('fs');
const path = require('path');
const https = require('node:https');
const http = require('node:http');
const { ROOT } = require('./paths');
const store = require('./store');

const REMOTE_FILE = path.join(ROOT, 'remote.json');

function loadRemote() {
    try {
        return JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function saveRemote(cfg) {
    fs.mkdirSync(path.dirname(REMOTE_FILE), { recursive: true });
    const tmp = REMOTE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, REMOTE_FILE);
    fs.chmodSync(REMOTE_FILE, 0o600);
}

// Push new ledger records to the remote /api/ingest endpoint. "New" = records
// whose ts > pushedAt (or all records if no prior push). Re-push is safe —
// the server returns duplicate counts but never double-stores.
async function push(opts = {}) {
    const remote = loadRemote();
    if (!remote) throw new Error('no remote configured — run: tt login <token> --endpoint <URL>');

    const state = store.loadState();
    const since = opts.since != null
        ? (opts.since === 'all' ? null : opts.since)
        : (state.remote && state.remote.pushedAt) || null;

    const records = store.loadRange(since, null).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    if (!records.length) {
        return { added: 0, duplicate: 0, invalid: 0, pushed: 0, endpoint: remote.endpoint };
    }

    const url = remote.endpoint.replace(/\/$/, '') + '/api/ingest';
    const body = JSON.stringify(records);
    const result = await request(url, body, remote.token);

    state.remote = state.remote || {};
    state.remote.pushedAt = new Date().toISOString();
    store.saveState(state);

    return { ...result, pushed: records.length, endpoint: remote.endpoint };
}

// HTTP/HTTPS request — uses global fetch when available (Node 18+), falls back
// to node:http/https so this stays zero-npm-dep in either runtime.
function request(url, body, token) {
    if (typeof fetch === 'function') {
        return fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
            body,
        }).then(async (res) => {
            if (!res.ok) {
                const msg = await res.text().catch(() => '');
                throw new Error('push failed (' + res.status + '): ' + msg.slice(0, 200));
            }
            return res.json();
        });
    }
    return nativePost(url, body, token);
}

function nativePost(url, body, token) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer ' + token,
                'content-length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('push failed (' + res.statusCode + '): ' + data.slice(0, 200)));
                }
                try { resolve(JSON.parse(data)); } catch {
                    reject(new Error('bad JSON from server: ' + data.slice(0, 100)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function remoteStatus() {
    const remote = loadRemote();
    const state = store.loadState();
    return {
        configured: !!remote,
        endpoint: remote ? remote.endpoint : null,
        autoPush: remote ? !!remote.autoPush : false,
        pushedAt: state.remote ? state.remote.pushedAt : null,
    };
}

module.exports = { REMOTE_FILE, loadRemote, saveRemote, push, remoteStatus };
