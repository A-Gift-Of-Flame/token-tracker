'use strict';

const fs = require('fs');
const { daemonPaths } = require('./daemon-paths');

function writeSessionEndMarker(payload = {}, opts = {}) {
    const fsObj = opts.fs || fs;
    const paths = opts.paths || daemonPaths(opts);
    fsObj.mkdirSync(paths.STATE_DIR, { recursive: true });
    fsObj.writeFileSync(paths.ENDED_FILE, JSON.stringify({
        sessionId: payload.session_id || payload.sessionId || null,
        ts: opts.now == null ? Date.now() : opts.now,
    }));
}

function readStdinJson(stdin, timeoutMs = 800) {
    return new Promise((resolve) => {
        let raw = '';
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            let obj = {};
            try { obj = raw ? JSON.parse(raw) : {}; } catch { obj = {}; }
            resolve(obj);
        };
        stdin.on('data', (d) => { raw += d; });
        stdin.on('end', finish);
        setTimeout(finish, timeoutMs).unref?.();
    });
}

async function runSessionEnd(opts = {}) {
    const payload = opts.payload || await readStdinJson(opts.stdin || process.stdin, opts.timeoutMs);
    writeSessionEndMarker(payload, opts);
    const exit = opts.exit || process.exit;
    exit(0);
}

module.exports = { readStdinJson, runSessionEnd, writeSessionEndMarker };
