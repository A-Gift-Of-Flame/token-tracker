'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const { daemonPaths } = require('./daemon-paths');
const { PresenceEngine } = require('./engine');
const { ClaudeTranscriptPresenceSource, DEFAULT_POLL_MS } = require('./claude-source');
const { CLAUDE_RE, daemonScriptPath, readLock, replaceOldDaemon } = require('./launcher');

const DEFAULT_IDLE_EXIT_MS = 10 * 60 * 1000;

function readJson(file, fallback, fsObj = fs) {
    try { return JSON.parse(fsObj.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeLock(paths, opts = {}) {
    const fsObj = opts.fs || fs;
    const pid = opts.pid || process.pid;
    const script = opts.daemonScript || daemonScriptPath();
    fsObj.mkdirSync(paths.STATE_DIR, { recursive: true });
    fsObj.writeFileSync(paths.LOCK, String(pid) + '\n' + script);
}

function releaseLock(paths, opts = {}) {
    const fsObj = opts.fs || fs;
    const pid = opts.pid || process.pid;
    const lock = readLock(paths, opts);
    if (lock && lock.pid === pid) {
        try { fsObj.unlinkSync(paths.LOCK); } catch { /* already gone */ }
    }
}

function claudePidStatus(pid, opts = {}) {
    if (!pid) return 'unknown';
    const kill = opts.kill || process.kill;
    const fsObj = opts.fs || fs;
    const platform = opts.platform || process.platform;
    try { kill(pid, 0); } catch { return 'dead'; }
    if (platform !== 'linux') return 'unknown';
    let comm = '';
    let cmdline = '';
    let readAny = false;
    try { comm = fsObj.readFileSync('/proc/' + pid + '/comm', 'utf8'); readAny = true; } catch { /* non-readable */ }
    try { cmdline = fsObj.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' '); readAny = true; } catch { /* non-readable */ }
    if (readAny && !CLAUDE_RE.test(comm) && !CLAUDE_RE.test(cmdline)) return 'mismatch';
    return 'alive';
}

function markerMatches(marker, sessionId) {
    if (!marker) return false;
    if (!marker.sessionId) return true;
    return marker.sessionId === sessionId;
}

function stateLastActivityMs(state) {
    const ts = state && state.timestamps && state.timestamps.lastActivityAt;
    const ms = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

class PresenceDaemon extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.opts = opts;
        this.fs = opts.fs || fs;
        this.paths = opts.paths || daemonPaths(opts);
        this.now = opts.now || Date.now;
        this.idleExitMs = opts.idleExitMs || DEFAULT_IDLE_EXIT_MS;
        this.checkMs = opts.checkMs || DEFAULT_POLL_MS;
        this.pid = opts.pid || process.pid;
        this.processObj = opts.processObj || process;
        this.exit = opts.exit || ((code) => process.exit(code));
        this.source = opts.source || new ClaudeTranscriptPresenceSource({
            pollMs: opts.sourcePollMs || DEFAULT_POLL_MS,
            freshnessMs: opts.freshnessMs,
            projectsDir: opts.projectsDir,
            pricingTable: opts.pricingTable,
        });
        this.engine = opts.engine || new PresenceEngine({
            source: this.source,
            stdout: opts.stdout,
            stderr: opts.stderr,
            processObj: this.processObj,
            exit: (code) => {
                releaseLock(this.paths, { fs: this.fs, pid: this.pid });
                this.exit(code);
            },
        });
        this.timer = null;
        this.lastActivityMs = this.now();
        this.latestSessionId = null;
        this.started = false;
        this.shuttingDown = false;
        this._onState = (state) => this.observeState(state);
        this._onSigint = () => this.shutdown('signal', 0);
        this._onSigterm = () => this.shutdown('signal', 0);
    }

    async start() {
        const guard = await replaceOldDaemon(this.paths, {
            ...this.opts,
            fs: this.fs,
            daemonScript: this.opts.daemonScript || daemonScriptPath(),
        });
        if (guard.action === 'already-running') {
            this.exit(0);
            return this;
        }
        writeLock(this.paths, { fs: this.fs, pid: this.pid, daemonScript: this.opts.daemonScript });
        this.source.on('state', this._onState);
        this.processObj.once('SIGINT', this._onSigint);
        this.processObj.once('SIGTERM', this._onSigterm);
        this.processObj.once('exit', () => releaseLock(this.paths, { fs: this.fs, pid: this.pid }));
        await this.engine.start();
        this.started = true;
        this.timer = setInterval(() => this.check(), this.checkMs);
        if (this.timer.unref) this.timer.unref();
        this.check();
        return this;
    }

    observeState(state) {
        const ms = stateLastActivityMs(state);
        if (ms !== null) this.lastActivityMs = ms;
        if (state && state.sessionId) this.latestSessionId = state.sessionId;
    }

    exitReason() {
        const live = readJson(this.paths.LIVE_FILE, null, this.fs);
        const sessionId = this.latestSessionId || (live && live.sessionId) || null;
        const ended = readJson(this.paths.ENDED_FILE, null, this.fs);
        if (markerMatches(ended, sessionId)) return 'session-end';

        if (live && live.pid) {
            const status = claudePidStatus(live.pid, this.opts);
            if (status === 'dead') return 'pid-dead';
            if (status === 'mismatch') return 'pid-reused';
        }

        if (this.now() - this.lastActivityMs > this.idleExitMs) return 'idle-timeout';
        return null;
    }

    check() {
        const reason = this.exitReason();
        if (reason) this.shutdown(reason, 0);
        return reason;
    }

    async shutdown(reason = 'shutdown', code = 0) {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.source.removeListener('state', this._onState);
        this.processObj.removeListener('SIGINT', this._onSigint);
        this.processObj.removeListener('SIGTERM', this._onSigterm);
        this.emit('shutdown', reason);
        try { await this.engine.shutdown(code); } finally {
            releaseLock(this.paths, { fs: this.fs, pid: this.pid });
        }
    }
}

async function runDaemon(opts = {}) {
    const daemon = new PresenceDaemon(opts);
    await daemon.start();
    return daemon;
}

module.exports = {
    DEFAULT_IDLE_EXIT_MS,
    PresenceDaemon,
    claudePidStatus,
    markerMatches,
    readJson,
    releaseLock,
    runDaemon,
    stateLastActivityMs,
    writeLock,
};
