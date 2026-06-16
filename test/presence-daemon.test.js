'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PresenceEngine } = require('../src/presence/engine');
const { renderPresenceActivity } = require('../src/presence/render');
const { daemonPaths } = require('../src/presence/daemon-paths');
const { PresenceDaemon, claudePidStatus } = require('../src/presence/daemon');
const { launchPresenceDaemon, daemonScriptPath } = require('../src/presence/launcher');
const { installPresenceHooks, uninstallPresenceHooks, START_COMMAND, END_COMMAND } = require('../src/presence/install');
const { readClaudePresenceState } = require('../src/presence/claude-source');
const { writeSessionEndMarker } = require('../src/presence/session-end');

function tmpdir(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

class FakeIPC {
    constructor() { this.calls = []; this.destroyed = false; }
    async connect() { this.calls.push(['connect']); }
    async setActivity(activity) { this.calls.push(['setActivity', activity]); return true; }
    async clear() { this.calls.push(['clear']); return this.setActivity(null); }
    destroy() { this.destroyed = true; }
}

class FakeSource extends EventEmitter {
    constructor(state) {
        super();
        this.state = state;
        this.stopped = false;
    }
    start() {
        if (this.state) this.emit('state', this.state);
    }
    stop() {
        this.stopped = true;
    }
}

function activeState(overrides = {}) {
    return {
        status: 'active',
        agent: 'claude-code',
        project: 'token-tracker',
        model: 'claude-opus-4-8',
        activity: 'Using Edit',
        sessionId: 's1',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        cost: { amount: 0.01, estimated: true },
        timestamps: { lastActivityAt: new Date().toISOString() },
        missing: [],
        ...overrides,
    };
}

async function startDaemonForExit(paths, opts = {}) {
    const ipc = new FakeIPC();
    const source = new FakeSource(opts.state || activeState());
    const proc = new EventEmitter();
    const exits = [];
    const engine = new PresenceEngine({
        ipc,
        source,
        processObj: proc,
        stdout: { write() {} },
        stderr: { write() {} },
        exit: (code) => exits.push(code),
    });
    const daemon = new PresenceDaemon({
        paths,
        source,
        engine,
        processObj: proc,
        checkMs: 100000,
        idleExitMs: opts.idleExitMs || 100000,
        kill: opts.kill,
        fs: opts.fs || fs,
        platform: opts.platform,
        now: opts.now,
        exit: (code) => exits.push(code),
    });
    const seen = new Promise((resolve) => daemon.once('shutdown', resolve));
    await daemon.start();
    await seen;
    await engine.done;
    return { ipc, source, exits, daemon };
}

test('launcher spawns daemon detached+unref, pins Claude pid, and exits without blocking', async () => {
    const root = tmpdir('tt-presence-launch-');
    const paths = daemonPaths({ root });
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });
    fs.writeFileSync(paths.ENDED_FILE, '{}');
    const spawned = [];
    const exits = [];
    await launchPresenceDaemon({ session_id: 'abc' }, {
        paths,
        claudePid: 4242,
        spawn: (cmd, argv, options) => {
            spawned.push({ cmd, argv, options, unref: false });
            return { unref: () => { spawned[0].unref = true; } };
        },
        exit: (code) => exits.push(code),
    });
    assert.equal(fs.existsSync(paths.ENDED_FILE), false, 'new session clears stale ended marker');
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.LIVE_FILE, 'utf8')), {
        sessionId: 'abc',
        pid: 4242,
        ts: JSON.parse(fs.readFileSync(paths.LIVE_FILE, 'utf8')).ts,
    });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.stdio, 'ignore');
    assert.equal(spawned[0].argv.slice(-2).join(' '), 'presence daemon');
    assert.equal(spawned[0].unref, true);
    assert.deepEqual(exits, [0]);
});

test('single-instance guard refuses same-version daemon and replaces old-version daemon', async () => {
    const sameRoot = tmpdir('tt-presence-lock-same-');
    const samePaths = daemonPaths({ root: sameRoot });
    fs.mkdirSync(samePaths.STATE_DIR, { recursive: true });
    fs.writeFileSync(samePaths.LOCK, '111\n' + daemonScriptPath());
    const sameSpawns = [];
    const sameExits = [];
    await launchPresenceDaemon({ session_id: 's1' }, {
        paths: samePaths,
        claudePid: 111,
        kill: (pid, sig) => {
            if (sig === 0 && pid === 111) return true;
            throw new Error('unexpected kill');
        },
        spawn: () => { sameSpawns.push(true); },
        exit: (code) => sameExits.push(code),
    });
    assert.equal(sameSpawns.length, 0);
    assert.deepEqual(sameExits, [0]);

    const oldRoot = tmpdir('tt-presence-lock-old-');
    const oldPaths = daemonPaths({ root: oldRoot });
    fs.mkdirSync(oldPaths.STATE_DIR, { recursive: true });
    fs.writeFileSync(oldPaths.LOCK, '222\n/old/daemon.js');
    let alive = true;
    const signals = [];
    const oldSpawns = [];
    await launchPresenceDaemon({ session_id: 's2' }, {
        paths: oldPaths,
        claudePid: 222,
        kill: (pid, sig) => {
            if (sig === 0) {
                if (alive) return true;
                throw new Error('dead');
            }
            signals.push([pid, sig]);
            alive = false;
            return true;
        },
        spawn: () => {
            oldSpawns.push(true);
            return { unref() {} };
        },
        exit: () => {},
    });
    assert.deepEqual(signals, [[222, 'SIGTERM']]);
    assert.equal(oldSpawns.length, 1);
});

test('dead Claude pid clears Discord activity and exits', async () => {
    const root = tmpdir('tt-presence-dead-');
    const paths = daemonPaths({ root });
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });
    fs.writeFileSync(paths.LIVE_FILE, JSON.stringify({ sessionId: 's1', pid: 999999, ts: Date.now() }));
    const { ipc, exits } = await startDaemonForExit(paths, {
        kill: () => { throw new Error('ESRCH'); },
    });
    assert.deepEqual(ipc.calls.at(-1), ['setActivity', null]);
    assert.deepEqual(exits, [0]);
});

test('/proc cmdline mismatch treats reused pid as dead and clears activity', async () => {
    const root = tmpdir('tt-presence-reuse-');
    const paths = daemonPaths({ root });
    fs.mkdirSync(paths.STATE_DIR, { recursive: true });
    fs.writeFileSync(paths.LIVE_FILE, JSON.stringify({ sessionId: 's1', pid: 1234, ts: Date.now() }));
    const fakeFs = {
        ...fs,
        readFileSync(file, enc) {
            if (file === '/proc/1234/comm') return 'bash\n';
            if (file === '/proc/1234/cmdline') return '/usr/bin/bash\0';
            return fs.readFileSync(file, enc);
        },
    };
    assert.equal(claudePidStatus(1234, { fs: fakeFs, platform: 'linux', kill: () => true }), 'mismatch');
    const { ipc } = await startDaemonForExit(paths, {
        fs: fakeFs,
        platform: 'linux',
        kill: () => true,
    });
    assert.deepEqual(ipc.calls.at(-1), ['setActivity', null]);
});

test('SessionEnd marker triggers immediate clear and exit', async () => {
    const root = tmpdir('tt-presence-ended-');
    const paths = daemonPaths({ root });
    writeSessionEndMarker({ session_id: 's1' }, { paths });
    const { ipc } = await startDaemonForExit(paths);
    assert.deepEqual(ipc.calls.at(-1), ['setActivity', null]);
});

test('idle-timeout fallback clears and exits when no reliable liveness is available', async () => {
    const root = tmpdir('tt-presence-idle-');
    const paths = daemonPaths({ root });
    const base = Date.parse('2026-06-15T12:00:00.000Z');
    const { ipc } = await startDaemonForExit(paths, {
        idleExitMs: 1000,
        now: () => base,
        state: activeState({
            timestamps: { lastActivityAt: new Date(base - 2000).toISOString() },
        }),
    });
    assert.deepEqual(ipc.calls.at(-1), ['setActivity', null]);
});

test('install/uninstall writes idempotent Claude SessionStart and SessionEnd hooks', () => {
    const root = tmpdir('tt-presence-install-');
    const settingsFile = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({
        hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep' }] }],
        },
    }));

    installPresenceHooks({ settingsFile });
    installPresenceHooks({ settingsFile });
    let settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const starts = settings.hooks.SessionStart.filter((entry) => entry.hooks.some((h) => h.command === START_COMMAND));
    const ends = settings.hooks.SessionEnd.filter((entry) => entry.hooks.some((h) => h.command === END_COMMAND));
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.ok(settings.hooks.SessionStart.some((entry) => entry.hooks.some((h) => h.command === 'echo keep')));

    uninstallPresenceHooks({ settingsFile });
    uninstallPresenceHooks({ settingsFile });
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.ok(settings.hooks.SessionStart.some((entry) => entry.hooks.some((h) => h.command === 'echo keep')));
    assert.equal(settings.hooks.SessionEnd, undefined);
    assert.equal(settings.hooks.SessionStart.some((entry) => entry.hooks.some((h) => h.command === START_COMMAND)), false);
});

test('Claude transcript source emits truthful normalized state and stale state when old', () => {
    const root = tmpdir('tt-presence-source-');
    const projectDir = path.join(root, '.claude', 'projects', '-home-me-token-tracker');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 's1.jsonl');
    const lines = [
        {
            type: 'user',
            sessionId: 's1',
            timestamp: '2026-06-15T11:59:58.000Z',
            cwd: '/home/me/token-tracker',
            message: { content: 'edit file' },
        },
        {
            type: 'assistant',
            sessionId: 's1',
            requestId: 'req1',
            timestamp: '2026-06-15T12:00:00.000Z',
            cwd: '/home/me/token-tracker',
            message: {
                model: 'claude-opus-4-8',
                usage: {
                    input_tokens: 1000,
                    output_tokens: 200,
                    cache_read_input_tokens: 50,
                    cache_creation_input_tokens: 20,
                },
                content: [{ type: 'tool_use', name: 'Edit' }],
            },
        },
    ];
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const pricingTable = {
        'claude-opus-4-8': {
            input_cost_per_token: 1e-6,
            output_cost_per_token: 5e-6,
            cache_read_input_token_cost: 0.1e-6,
            cache_creation_input_token_cost: 1.25e-6,
        },
    };

    const fresh = readClaudePresenceState({
        projectsDir: path.join(root, '.claude', 'projects'),
        pricingTable,
        now: Date.parse('2026-06-15T12:00:05.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(fresh.status, 'active');
    assert.equal(fresh.agent, 'claude-code');
    assert.equal(fresh.project, 'token-tracker');
    assert.equal(fresh.model, 'claude-opus-4-8');
    assert.equal(fresh.activity, 'Using Edit');
    assert.deepEqual(fresh.tokens, { input: 1000, output: 200, cacheRead: 50, cacheWrite: 20 });
    assert.equal(fresh.cost.estimated, true);
    assert.equal(fresh.missing.length, 0);
    assert.match(renderPresenceActivity(fresh, {
        now: Date.parse('2026-06-15T12:00:05.000Z'),
        freshnessMs: 60000,
    }).state, /Using Edit/);

    const stale = readClaudePresenceState({
        projectsDir: path.join(root, '.claude', 'projects'),
        pricingTable,
        now: Date.parse('2026-06-15T12:10:00.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(stale.status, 'stale');
});
