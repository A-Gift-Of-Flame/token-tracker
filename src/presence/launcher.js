'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { daemonPaths } = require('./daemon-paths');
const { readStdinJson } = require('./session-end');

const CLAUDE_RE = /(?:^|[/\s])claude(?:-code)?(?:[/\s]|$)/;

function daemonScriptPath() {
    return path.join(__dirname, 'daemon.js');
}

function cliPath() {
    return path.join(__dirname, '..', '..', 'bin', 'tt.js');
}

function readProcText(pid, name, fsObj = fs) {
    return fsObj.readFileSync('/proc/' + pid + '/' + name, 'utf8');
}

function findClaudePid(startPid, opts = {}) {
    const fsObj = opts.fs || fs;
    let pid = Number(startPid);
    for (let i = 0; i < 24 && pid > 1; i++) {
        let comm = '';
        try { comm = readProcText(pid, 'comm', fsObj).trim(); } catch { return null; }
        if (CLAUDE_RE.test(comm)) return pid;
        try {
            const cmdline = readProcText(pid, 'cmdline', fsObj).replace(/\0/g, ' ');
            if (CLAUDE_RE.test(cmdline)) return pid;
        } catch { /* keep walking */ }
        let ppid = 0;
        try {
            const stat = readProcText(pid, 'stat', fsObj);
            const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            ppid = parseInt(tail[1], 10);
        } catch { return null; }
        if (!ppid || ppid === pid) return null;
        pid = ppid;
    }
    return null;
}

function alive(pid, opts = {}) {
    if (!pid || Number.isNaN(pid)) return false;
    const kill = opts.kill || process.kill;
    try { kill(pid, 0); return true; } catch { return false; }
}

function readLock(paths, opts = {}) {
    const fsObj = opts.fs || fs;
    try {
        const [pidLine, script] = fsObj.readFileSync(paths.LOCK, 'utf8').split('\n');
        return { pid: parseInt(pidLine, 10), script: script || null };
    } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGone(pid, ms, opts = {}) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!alive(pid, opts)) return true;
        await sleep(opts.stepMs || 50);
    }
    return !alive(pid, opts);
}

async function replaceOldDaemon(paths, opts = {}) {
    const fsObj = opts.fs || fs;
    const kill = opts.kill || process.kill;
    const script = opts.daemonScript || daemonScriptPath();
    const lock = readLock(paths, opts);
    if (!lock) return { action: 'none' };
    if (alive(lock.pid, opts)) {
        if (lock.script === script) return { action: 'already-running', pid: lock.pid };
        try { kill(lock.pid, 'SIGTERM'); } catch { /* process may have exited */ }
        if (!(await waitGone(lock.pid, opts.termWaitMs || 2000, opts))) {
            try { kill(lock.pid, 'SIGKILL'); } catch { /* best effort */ }
            await waitGone(lock.pid, opts.killWaitMs || 500, opts);
        }
    }
    try { fsObj.unlinkSync(paths.LOCK); } catch { /* stale lock already gone */ }
    return { action: 'replaced', pid: lock.pid };
}

async function launchPresenceDaemon(payload = {}, opts = {}) {
    const fsObj = opts.fs || fs;
    const paths = opts.paths || daemonPaths(opts);
    const sessionId = payload.session_id || payload.sessionId || null;
    try { fsObj.unlinkSync(paths.ENDED_FILE); } catch { /* new session clears stale clean-exit marker */ }

    const claudePid = opts.claudePid === undefined
        ? findClaudePid(opts.parentPid || process.ppid, opts)
        : opts.claudePid;
    if (claudePid) {
        fsObj.mkdirSync(paths.STATE_DIR, { recursive: true });
        fsObj.writeFileSync(paths.LIVE_FILE, JSON.stringify({
            sessionId,
            pid: claudePid,
            ts: opts.now == null ? Date.now() : opts.now,
        }));
    }

    const guard = await replaceOldDaemon(paths, opts);
    if (guard.action === 'already-running') {
        const exit = opts.exit || process.exit;
        exit(0);
        return { spawned: false, guard };
    }

    fsObj.mkdirSync(paths.STATE_DIR, { recursive: true });
    const spawnFn = opts.spawn || spawn;
    const child = spawnFn(opts.execPath || process.execPath, [
        opts.cliPath || cliPath(),
        'presence',
        'daemon',
    ], {
        detached: true,
        stdio: 'ignore',
    });
    if (child && typeof child.unref === 'function') child.unref();
    const exit = opts.exit || process.exit;
    exit(0);
    return { spawned: true, guard, child };
}

async function runLauncher(opts = {}) {
    const payload = opts.payload || await readStdinJson(opts.stdin || process.stdin, opts.timeoutMs);
    return launchPresenceDaemon(payload, opts);
}

module.exports = {
    CLAUDE_RE,
    alive,
    cliPath,
    daemonScriptPath,
    findClaudePid,
    launchPresenceDaemon,
    readLock,
    replaceOldDaemon,
    runLauncher,
    waitGone,
};
