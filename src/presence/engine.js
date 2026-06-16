'use strict';

const EventEmitter = require('events');
const path = require('path');
const { ROOT, readJson } = require('../paths');
const { DiscordIPC } = require('./discord-ipc');
const { PresenceMultiplexer } = require('./multiplex');
const { renderMultiplexActivity, renderPresenceActivity } = require('./render');
const { StorePresenceSource, DEFAULT_FRESHNESS_MS, DEFAULT_POLL_MS } = require('./source');

const DEFAULT_CLIENT_ID = '1511532478492315821';
const PRESENCE_FILE = path.join(ROOT, 'presence.json');
const LIVE_AGENT_SOURCES = ['claude', 'codex', 'gemini', 'opencode'];
const PRESENCE_SOURCES = new Set(['store', ...LIVE_AGENT_SOURCES, 'all']);
const SOURCE_TIERS = { claude: 2, codex: 1, gemini: 1, opencode: 1 };

function loadPresenceConfig() {
    return readJson(PRESENCE_FILE, {}) || {};
}

function resolveClientId(cfg = loadPresenceConfig(), env = process.env) {
    return env.CLAUDE_DRPC_CLIENT_ID || env.TT_PRESENCE_CLIENT_ID || cfg.clientId || DEFAULT_CLIENT_ID;
}

function createPresenceSource(name = 'store', opts = {}) {
    if (name === 'store') {
        return new StorePresenceSource({
            pollMs: opts.pollMs || DEFAULT_POLL_MS,
            freshnessMs: opts.freshnessMs || DEFAULT_FRESHNESS_MS,
        });
    }
    if (name === 'claude') {
        const { ClaudeTranscriptPresenceSource } = require('./claude-source');
        return new ClaudeTranscriptPresenceSource(opts);
    }
    if (name === 'codex') {
        const { CodexRolloutPresenceSource } = require('./codex-source');
        return new CodexRolloutPresenceSource(opts);
    }
    if (name === 'gemini') {
        const { GeminiSessionPresenceSource } = require('./gemini-source');
        return new GeminiSessionPresenceSource(opts);
    }
    if (name === 'opencode') {
        const { OpenCodeDbPresenceSource } = require('./opencode-source');
        return new OpenCodeDbPresenceSource(opts);
    }
    throw new Error('unknown presence source: ' + name);
}

class PresenceEngine extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.ipc = opts.ipc || new DiscordIPC(opts.clientId || resolveClientId());
        this.source = opts.source || new StorePresenceSource({
            pollMs: opts.pollMs || DEFAULT_POLL_MS,
            freshnessMs: opts.freshnessMs || DEFAULT_FRESHNESS_MS,
        });
        this.render = opts.render || ((state) => renderPresenceActivity(state, {
            freshnessMs: opts.freshnessMs || DEFAULT_FRESHNESS_MS,
        }));
        this.processObj = opts.processObj || process;
        this.stdout = opts.stdout || process.stdout;
        this.stderr = opts.stderr || process.stderr;
        this.exit = opts.exit || ((code) => process.exit(code));
        this.started = false;
        this.shuttingDown = false;
        this._onState = null;
        this._onSigint = null;
        this._onSigterm = null;
        this._lastPublish = Promise.resolve();
        this._lastRendered = null;
        this.done = new Promise((resolve) => { this._resolveDone = resolve; });
    }

    async start() {
        await this.ipc.connect();
        this.started = true;
        this._onState = (state) => this.publish(state);
        this.source.on('state', this._onState);
        this._bindSignals();
        this.source.start();
        this._write(this.stdout, 'presence: connected to Discord IPC; Ctrl-C clears activity and exits\n');
        return this;
    }

    publish(state) {
        const activity = this.render(state);
        const sig = JSON.stringify(activity);
        if (sig === this._lastRendered) return this._lastPublish;
        this._lastRendered = sig;
        this._lastPublish = this._lastPublish
            .then(() => this.ipc.setActivity(activity))
            .catch((err) => {
                this._write(this.stderr, 'presence: update failed: '
                    + (err && err.message ? err.message : err) + '\n');
            });
        return this._lastPublish;
    }

    async shutdown(code = 0) {
        if (this.shuttingDown) return this.done;
        this.shuttingDown = true;
        this._unbindSignals();
        if (this._onState) this.source.removeListener('state', this._onState);
        if (this.source.stop) this.source.stop();
        try { await this._lastPublish; } catch { /* already reported */ }
        try { await this.ipc.clear(); } catch { /* best effort clear */ }
        if (this.ipc.destroy) this.ipc.destroy();
        this._write(this.stdout, 'presence: cleared Discord activity\n');
        this._resolveDone(code);
        this.exit(code);
        return this.done;
    }

    _bindSignals() {
        this._onSigint = () => { this.shutdown(0); };
        this._onSigterm = () => { this.shutdown(0); };
        this.processObj.once('SIGINT', this._onSigint);
        this.processObj.once('SIGTERM', this._onSigterm);
    }

    _unbindSignals() {
        if (this._onSigint) this.processObj.removeListener('SIGINT', this._onSigint);
        if (this._onSigterm) this.processObj.removeListener('SIGTERM', this._onSigterm);
        this._onSigint = null;
        this._onSigterm = null;
    }

    _write(stream, text) {
        if (stream && typeof stream.write === 'function') stream.write(text);
    }
}

async function runPresence(opts = {}) {
    const cfg = loadPresenceConfig();
    const freshnessMs = opts.freshnessMs || Number(cfg.freshnessSeconds || 0) * 1000 || DEFAULT_FRESHNESS_MS;
    const pollMs = opts.pollMs || Number(cfg.intervalSeconds || 0) * 1000 || DEFAULT_POLL_MS;
    const sourceName = opts.sourceName || opts.source || 'store';
    if (!PRESENCE_SOURCES.has(sourceName)) {
        throw new Error('unknown presence source: ' + sourceName
            + ' (want: ' + Array.from(PRESENCE_SOURCES).join('|') + ')');
    }
    const multiplex = sourceName === 'all';
    const source = opts.presenceSource || (multiplex
        ? new PresenceMultiplexer({
            freshnessMs,
            sources: LIVE_AGENT_SOURCES.map((name) => ({
                name,
                tier: SOURCE_TIERS[name],
                source: createPresenceSource(name, { ...opts, pollMs, freshnessMs }),
            })),
        })
        : createPresenceSource(sourceName, { ...opts, pollMs, freshnessMs }));
    const engine = new PresenceEngine({
        clientId: opts.clientId || resolveClientId(cfg),
        pollMs,
        freshnessMs,
        source,
        render: multiplex ? ((state) => renderMultiplexActivity(state, { freshnessMs })) : undefined,
        stdout: opts.stdout,
        stderr: opts.stderr,
        processObj: opts.processObj,
        exit: opts.exit,
    });
    try {
        await engine.start();
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        throw new Error('could not start presence: ' + msg);
    }
    return engine.done;
}

module.exports = {
    DEFAULT_CLIENT_ID,
    LIVE_AGENT_SOURCES,
    PRESENCE_FILE,
    PRESENCE_SOURCES,
    PresenceEngine,
    SOURCE_TIERS,
    createPresenceSource,
    loadPresenceConfig,
    resolveClientId,
    runPresence,
};
