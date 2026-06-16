'use strict';

// BL-129: CLI push client. Zero-dep transport (global fetch / node:http+https
// fallback). No background push — explicit tt push only. Token stored in
// remote.json at 0600 so the plaintext is not readable by other users on the
// host. Insertion-order high-water mark (state.remote.offsets: per-month-file
// pushed counts) so auto-push never drops late-flushed past-dated records;
// re-push stays idempotent — the server dedups by (user_id, record id) anyway.

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithGithubDevice(opts = {}) {
    const endpoint = String(opts.endpoint || '').replace(/\/$/, '');
    if (!endpoint) throw new Error('need --endpoint <URL>, e.g. tt login --github --endpoint https://tt.example.com');
    const log = opts.log || console.log;
    const sleeper = opts.sleep || sleep;

    const start = await jsonRequest('POST', endpoint + '/api/auth/github/device/start', {});
    if (!start.body || !start.body.poll_token) throw new Error('server did not return a GitHub device poll token');

    log('GitHub device login');
    log('open: ' + (start.body.verification_uri_complete || start.body.verification_uri));
    log('code: ' + start.body.user_code);
    log('waiting for authorization...');

    let intervalMs = opts.pollMs != null
        ? Number(opts.pollMs)
        : Math.max(1, Number(start.body.interval || 5)) * 1000;
    const expiresAt = Date.now() + Math.max(1, Number(start.body.expires_in || 900)) * 1000;

    while (Date.now() < expiresAt) {
        await sleeper(intervalMs);
        const poll = await jsonRequest('POST', endpoint + '/api/auth/github/device/poll', {
            poll_token: start.body.poll_token,
        }, { allowStatuses: new Set([200, 202, 403, 410, 409, 502]) });

        if (poll.status === 202) {
            if (poll.body && poll.body.status === 'slow_down') {
                intervalMs = poll.body.interval ? Math.max(intervalMs, Number(poll.body.interval) * 1000) : intervalMs + 5000;
            }
            continue;
        }
        if (poll.status === 200 && poll.body && poll.body.status === 'complete' && poll.body.token) {
            saveRemote({ token: poll.body.token, endpoint, autoPush: !!opts.autoPush });
            log('saved remote config (remote.json)');
            log('endpoint: ' + endpoint);
            if (opts.autoPush) log('auto-push: on');
            return { token: poll.body.token, endpoint, autoPush: !!opts.autoPush };
        }
        const msg = poll.body && poll.body.error ? poll.body.error : 'GitHub device login failed';
        throw new Error(msg);
    }
    throw new Error('GitHub device login expired');
}

// Push new ledger records to the remote /api/ingest endpoint. Two selection
// modes:
//   default (auto-push / `tt push`): insertion-order high-water mark — every
//     record appended since the last successful push, tracked as per-month-file
//     counts in state.remote.offsets. This survives out-of-order timestamps
//     (see store.loadUnpushed); a ts-based mark drops late-flushed past-dated
//     records.
//   `tt push --since ISO|all`: explicit ts-range backfill, unchanged. Re-push is
//     safe either way — the server dedups by (user_id, record id).
async function push(opts = {}) {
    const remote = loadRemote();
    if (!remote) throw new Error('no remote configured — run: tt login <token> --endpoint <URL>');

    const state = store.loadState();
    state.remote = state.remote || {};

    let records, newOffsets = null;
    if (opts.since != null) {
        const since = opts.since === 'all' ? null : opts.since;
        records = store.loadRange(since, null).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    } else {
        const unpushed = store.loadUnpushed(state.remote.offsets || {});
        records = unpushed.records;
        newOffsets = unpushed.counts;
    }

    if (!records.length) {
        return { added: 0, duplicate: 0, invalid: 0, pushed: 0, endpoint: remote.endpoint };
    }

    const url = remote.endpoint.replace(/\/$/, '') + '/api/ingest';
    const body = JSON.stringify(records);
    const result = await request(url, body, remote.token);

    state.remote.pushedAt = new Date().toISOString();
    // Advance the insertion-order mark only on success; on throw the offsets stay
    // put and the same records retry next push.
    if (newOffsets) state.remote.offsets = newOffsets;
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

function jsonRequest(method, url, body, opts = {}) {
    return new Promise((resolve, reject) => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const headers = {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
        };
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method,
            headers,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > 1024 * 1024) {
                    req.destroy(new Error('response too large'));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = {};
                try { parsed = text ? JSON.parse(text) : {}; } catch (err) { return reject(err); }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                const allowed = opts.allowStatuses && opts.allowStatuses.has(res.statusCode);
                if (!ok && !allowed) {
                    const msg = parsed && parsed.error ? parsed.error : text.slice(0, 200);
                    return reject(new Error('request failed (' + res.statusCode + '): ' + msg));
                }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (raw) req.write(raw);
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

module.exports = { REMOTE_FILE, loadRemote, saveRemote, push, remoteStatus, loginWithGithubDevice };
